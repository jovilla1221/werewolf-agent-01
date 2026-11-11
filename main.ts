// werewolf-agent-01 entry: a deterministic, rule-based Werewolf player.
// No model calls at all. Every decision is a pure function of that one game's
// view as served by the env at MAKEFUN_ENV_URL: no wall clock, no randomness,
// no cross-game state. The same view always produces the same answer, so the
// live pass and the replay pass send identical requests.
//
// Protocol (from the brief): POST /observe lists pending decisions, POST /act
// answers one. Decisions are answered one at a time, in the order /observe
// lists them, which keeps the request order deterministic. The run exits
// when /observe says done.
//
// Strategy, in short:
//  - Parse every public speech for seer claims (who claims, whom they name as
//    a werewolf, whom they clear), accusations, defences and doctor claims.
//  - Score every seat from public facts only: revealed roles, exile votes,
//    votes cast alongside a revealed werewolf, defences of a revealed
//    werewolf, night victims' earlier accusations, silence, claim logic.
//  - Seer: inspect the most suspicious uninspected seat; claim from day 2
//    once a werewolf is found, and push that vote.
//  - Doctor: protect a credible claimed seer first, then cleared seats and
//    strong accusers of the top suspect.
//  - Villager: follow an uncountered seer claim; otherwise vote the highest
//    suspicion seat, joining a plurality when that secures an exile.
//  - Werewolf: match the partner's kill pick when it is already in; kill a
//    claimed seer, then seats that accused the wolves, then cleared seats.
//    By day, blend in, push the village's alternative suspect, bus a doomed
//    partner, and counter-claim seer only when a seer claim names you.
// Statements are short, factual, name one target with one reason, and stay
// well under the 500 character limit.

import { pathToFileURL } from 'node:url';

type Seat = number;
type DecisionKind = 'speak' | 'vote' | 'kill' | 'protect' | 'inspect';

interface Player {
  seat: Seat;
  name: string;
  alive: boolean;
  role: string | null;
}

interface LogEntry {
  seq: number;
  day: number;
  kind: string;
  seat?: Seat;
  round?: number;
  text?: string;
  target?: Seat | null;
  died?: Seat | null;
  role?: string | null;
  tally?: { seat: Seat; votes: number }[];
}

interface View {
  day: number;
  phase: string;
  you: {
    seat: Seat;
    name: string;
    role: string;
    alive: boolean;
    partner: { seat: Seat; name: string; alive: boolean } | null;
  };
  players: Player[];
  seerResults: { night: number; seat: Seat; werewolf: boolean }[] | null;
  lastProtect: { night: number; seat: Seat | null } | null;
  wolfVotes: { night: number; seat: Seat; target: Seat | null }[] | null;
  log: LogEntry[];
  outcome: unknown;
}

interface Pending {
  game: number;
  decision: DecisionKind;
  options?: Seat[];
  max_chars?: number;
  view: View;
}

interface Claim {
  claimer: Seat;
  day: number;
  wolfTargets: Seat[];
  cleared: Seat[];
  credibility: number;
  fake: boolean;
}

interface Analysis {
  scores: Map<Seat, number>;
  reasons: Map<Seat, string[]>;
  claims: Claim[];
  bestClaim: Claim | null;
  doctorClaimers: Set<Seat>;
  accusedBy: Map<Seat, Set<Seat>>;
  defendedBy: Map<Seat, Set<Seat>>;
  revealed: Map<Seat, string>;
  votesToday: Map<Seat, number>;
  knownWolves: Set<Seat>;
  knownClear: Set<Seat>;
  speechesTodayByMe: number;
  accusedMeToday: Set<Seat>;
  votesCastToday: number;
  currentRound: number;
  iCounterClaimed: boolean;
  iClaimedSeer: boolean;
}

const nameOf = (view: View, seat: Seat): string => {
  const p = view.players.find((pl) => pl.seat === seat);
  return p ? `${p.name} (seat ${seat})` : `seat ${seat}`;
};
const shortOf = (view: View, seat: Seat): string => {
  const p = view.players.find((pl) => pl.seat === seat);
  return p ? p.name : `seat ${seat}`;
};
const aliveSeats = (view: View): Seat[] => view.players.filter((p) => p.alive).map((p) => p.seat);

function addReason(a: Analysis, seat: Seat, reason: string): void {
  const list = a.reasons.get(seat) ?? [];
  if (!list.includes(reason)) list.push(reason);
  a.reasons.set(seat, list);
}
function addScore(a: Analysis, seat: Seat, delta: number, reason?: string): void {
  a.scores.set(seat, (a.scores.get(seat) ?? 0) + delta);
  if (reason) addReason(a, seat, reason);
}

/** Seats a sentence mentions, by "seat N" or by player name. */
function mentionsIn(view: View, sentence: string, except: Seat): Seat[] {
  const out: Seat[] = [];
  for (const p of view.players) {
    if (p.seat === except) continue;
    const bySeat = new RegExp(`\\bseat\\s*${p.seat}\\b`).test(sentence);
    const byName = new RegExp(`\\b${p.name.toLowerCase().replace(/[.*+?^${'{}'}()|[\\]\\\\]/g, '\\$&')}\\b`).test(sentence);
    if (bySeat || byName) out.push(p.seat);
  }
  return out;
}

export function analyze(view: View): Analysis {
  const a: Analysis = {
    scores: new Map(),
    reasons: new Map(),
    claims: [],
    bestClaim: null,
    doctorClaimers: new Set(),
    accusedBy: new Map(),
    defendedBy: new Map(),
    revealed: new Map(),
    votesToday: new Map(),
    knownWolves: new Set(),
    knownClear: new Set(),
    speechesTodayByMe: 0,
    accusedMeToday: new Set(),
    votesCastToday: 0,
    currentRound: 1,
    iCounterClaimed: false,
    iClaimedSeer: false,
  };
  for (const p of view.players) a.scores.set(p.seat, 0);

  // Private knowledge first: it is part of this game's view alone.
  if (view.you.role === 'werewolf' && view.you.partner) {
    a.knownWolves.add(view.you.partner.seat);
  }
  if (view.seerResults) {
    for (const r of view.seerResults) {
      if (r.werewolf) a.knownWolves.add(r.seat);
      else a.knownClear.add(r.seat);
    }
  }

  const recordAccusation = (target: Seat, speaker: Seat, day: number) => {
    if (!accusations.has(target)) accusations.set(target, new Set());
    accusations.get(target)!.add(speaker);
    if (!a.accusedBy.has(target)) a.accusedBy.set(target, new Set());
    a.accusedBy.get(target)!.add(speaker);
    if (day === view.day && target === view.you.seat) a.accusedMeToday.add(speaker);
  };

  const votesByDay = new Map<number, { seat: Seat; target: Seat | null }[]>();
  const accusations = new Map<Seat, Set<Seat>>(); // target -> accusers, all game
  const claimBySpeaker = new Map<Seat, Claim>();
  const rawClaims: Claim[] = [];
  const spokeEver = new Set<Seat>();

  const pushClaim = (c: Claim) => {
    const existing = claimBySpeaker.get(c.claimer);
    if (existing) {
      for (const t of c.wolfTargets) if (!existing.wolfTargets.includes(t)) existing.wolfTargets.push(t);
      for (const t of c.cleared) if (!existing.cleared.includes(t)) existing.cleared.push(t);
    } else {
      claimBySpeaker.set(c.claimer, c);
      rawClaims.push(c);
    }
  };

  for (const e of view.log) {
    if (e.kind === 'dawn') {
      if (e.died != null) {
        if (e.role) a.revealed.set(e.died, e.role);
        // Whoever the night victim had accused is a little more suspect:
        // wolves silence accusers.
        for (const [target, accusers] of accusations) {
          if (accusers.has(e.died)) {
            addScore(a, target, 16, `${shortOf(view, e.died)} accused them before being killed at night`);
          }
        }
      }
    } else if (e.kind === 'speech' && typeof e.text === 'string' && e.seat != null) {
      const speaker = e.seat;
      spokeEver.add(speaker);
      if (speaker === view.you.seat && e.day === view.day) a.speechesTodayByMe += 1;
      if (e.day === view.day && e.round != null && e.round > a.currentRound) a.currentRound = e.round;
      const text = e.text.toLowerCase();
      if (speaker === view.you.seat && text.includes('seer')) {
        if (text.includes('real seer')) a.iCounterClaimed = true;
        if (text.includes('i am the seer') || text.includes("i'm the seer")) a.iClaimedSeer = true;
      }
      if (/i am the doctor|i'm the doctor|i claim doctor/.test(text)) a.doctorClaimers.add(speaker);

      // Guard: a hypothetical or negated mention is never a claim, even
      // when it contains claim-like words ("if I were the seer, I would...",
      // "I am not the seer", "I'm not the seer", "not a seer").
      const claimBlocked = /if i (were|was) the seer|i am not the seer|i'm not the seer|i am no seer|not a seer/.test(text);
      const claimsSeer =
        !claimBlocked &&
        text.includes('seer') &&
        (/i am the seer|i'm the seer|i am seer|i claim|as the seer|i inspected|i checked|my inspection|i investigated/.test(text) ||
          /seer,? (and )?i/.test(text));
      const claim: Claim | null = claimsSeer
        ? { claimer: speaker, day: e.day, wolfTargets: [], cleared: [], credibility: 0, fake: false }
        : null;

      for (const rawSentence of text.split(/(?<=[.!?])\s+/)) {
        const sentence = rawSentence;
        const mentions = mentionsIn(view, sentence, speaker);
        if (mentions.length === 0) continue;
        const negWolf = /not a werewolf|not a wolf|isn't a werewolf|is not a werewolf|innocent|cleared|clear\b|villager|not suspicious/.test(sentence);
        const wolfWord = /werewolf|werewolves|\bwolf\b|\bwolves\b/.test(sentence);
        const accuseWord = wolfWord || /suspicious|suspect|lying|liar|fake|exile|vote/.test(sentence);
        for (const m of mentions) {
          if (wolfWord && !negWolf) {
            if (claim) {
              if (!claim.wolfTargets.includes(m)) claim.wolfTargets.push(m);
            }
            recordAccusation(m, speaker, e.day);
          } else if (negWolf || /trust|believe|defend/.test(sentence)) {
            if (claim && negWolf && !a.knownWolves.has(m)) {
              if (!claim.cleared.includes(m)) claim.cleared.push(m);
            }
            if (!a.defendedBy.has(m)) a.defendedBy.set(m, new Set());
            a.defendedBy.get(m)!.add(speaker);
          } else if (accuseWord) {
            recordAccusation(m, speaker, e.day);
          }
        }
      }
      if (claim && (claim.wolfTargets.length > 0 || claim.cleared.length > 0 || e.day >= 1)) pushClaim(claim);
    } else if (e.kind === 'pass' && e.seat != null) {
      if (e.day === view.day && e.round != null && e.round > a.currentRound) a.currentRound = e.round;
    } else if (e.kind === 'vote' && e.seat != null) {
      const list = votesByDay.get(e.day) ?? [];
      list.push({ seat: e.seat, target: e.target ?? null });
      votesByDay.set(e.day, list);
      if (e.day === view.day) a.votesCastToday += 1;
      if (e.day === view.day && e.target != null) {
        a.votesToday.set(e.target, (a.votesToday.get(e.target) ?? 0) + 1);
      }
    } else if (e.kind === 'exile') {
      if (e.seat != null && e.role) {
        const exiled = e.seat;
        const role = e.role;
        a.revealed.set(exiled, role);
        const dayVotes = votesByDay.get(e.day) ?? [];
        if (role === 'werewolf') {
          for (const v of dayVotes) {
            if (v.target === exiled) addScore(a, v.seat, -18);
          }
          // Defenders of a revealed werewolf look like its partner.
          for (const d of a.defendedBy.get(exiled) ?? []) {
            addScore(a, d, 22, `defended ${shortOf(view, exiled)}, who was a werewolf`);
          }
          // Seats that voted the same way this wolf did, on any day, on a
          // target that was not a werewolf.
          for (const [, votes] of votesByDay) {
            const wolfVote = votes.find((v) => v.seat === exiled);
            if (!wolfVote || wolfVote.target == null) continue;
            const tRole = a.revealed.get(wolfVote.target);
            if (tRole === 'werewolf') continue;
            for (const v of votes) {
              if (v.seat !== exiled && v.target === wolfVote.target) {
                addScore(a, v.seat, 10, `voted with ${shortOf(view, exiled)}, a revealed werewolf`);
              }
            }
          }
        } else {
          for (const v of dayVotes) {
            if (v.target === exiled) {
              addScore(a, v.seat, 18, `voted to exile ${shortOf(view, exiled)}, who was a ${role}`);
            }
          }
        }
      }
    } else if (e.kind === 'end') {
      // Nothing to learn for this game any more.
    }
  }

  // Accusations: each distinct accuser adds a little. An accusation from a
  // revealed werewolf counts the other way (likely framing a villager).
  for (const [target, accusers] of accusations) {
    for (const acc of accusers) {
      if (a.revealed.get(acc) === 'werewolf') addScore(a, target, -8);
      else addScore(a, target, 7);
    }
    if (accusers.size >= 2) addReason(a, target, `accused by ${accusers.size} different players`);
  }

  // Silence while the game moves on.
  if (view.day >= 2) {
    for (const p of view.players) {
      if (p.alive && !spokeEver.has(p.seat) && p.seat !== view.you.seat) {
        addScore(a, p.seat, 8, 'has stayed silent so far');
      }
    }
  }

  // Judge the seer claims.
  const distinctClaimers = new Set(rawClaims.map((c) => c.claimer));
  for (const c of rawClaims) {
    let cred = 0.85;
    const claimerRole = a.revealed.get(c.claimer);
    if (claimerRole && claimerRole !== 'seer') {
      c.fake = true;
      cred = 0;
      addScore(a, c.claimer, 70, `claimed seer but was a ${claimerRole}`);
    }
    if (claimerRole === 'seer') cred = 1;
    for (const t of c.wolfTargets) {
      const r = a.revealed.get(t);
      if (r && r !== 'werewolf') {
        c.fake = true;
        cred = 0;
        addScore(a, c.claimer, 60, `claimed seer and named ${shortOf(view, t)}, who was a ${r}`);
      }
      if (r === 'werewolf') cred = 1;
    }
    for (const t of c.cleared) {
      if (a.revealed.get(t) === 'werewolf') {
        c.fake = true;
        cred = 0;
        addScore(a, c.claimer, 60, `claimed seer and cleared a werewolf`);
      }
    }
    if (distinctClaimers.size >= 2) {
      // Counter-claims: at most one can be the real seer.
      const otherClaims = rawClaims.filter((o) => o.claimer !== c.claimer);
      const namedByOther = otherClaims.some((o) => o.wolfTargets.includes(c.claimer));
      if (namedByOther) cred = Math.min(cred, 0.5);
      else cred = Math.min(cred, 0.45);
    }
    if (c.day >= 4 && view.day >= 4) cred = Math.min(cred, 0.6); // late claims are weaker, not void
    c.credibility = c.fake ? 0 : cred;
  }
  const credible = rawClaims.filter((c) => !c.fake && c.credibility >= 0.6 && c.wolfTargets.length > 0);
  credible.sort((x, y) => y.credibility - x.credibility || y.day - x.day || x.claimer - y.claimer);
  a.bestClaim = credible[0] ?? null;
  a.claims = rawClaims;

  for (const c of rawClaims) {
    if (c.fake) continue;
    for (const t of c.wolfTargets) addScore(a, t, Math.round(65 * c.credibility), `named as a werewolf by seer claimant ${shortOf(view, c.claimer)}`);
    for (const t of c.cleared) addScore(a, t, -Math.round(55 * c.credibility), `cleared by seer claimant ${shortOf(view, c.claimer)}`);
  }

  // Revealed and privately known roles settle it.
  for (const [seat, role] of a.revealed) {
    a.scores.set(seat, role === 'werewolf' ? 1000 : -1000);
  }
  for (const s of a.knownWolves) a.scores.set(s, 1000);
  for (const s of a.knownClear) a.scores.set(s, -1000);
  a.scores.set(view.you.seat, -1000);
  if (view.you.role === 'werewolf' && view.you.partner) a.scores.set(view.you.partner.seat, -1000);

  return a;
}

/** Highest-suspicion seat among options; ties go to the lowest seat number. */
function topSuspect(a: Analysis, options: Seat[], exclude?: Set<Seat>): Seat | null {
  let best: Seat | null = null;
  let bestScore = -Infinity;
  for (const s of [...options].sort((x, y) => x - y)) {
    if (exclude && exclude.has(s)) continue;
    const sc = a.scores.get(s) ?? 0;
    if (sc > bestScore) {
      bestScore = sc;
      best = s;
    }
  }
  return best;
}

function reasonFor(a: Analysis, seat: Seat): string {
  const list = a.reasons.get(seat) ?? [];
  return list.length > 0 ? list[0]! : 'their votes and words fit a werewolf';
}

function fold(text: string): string {
  return text.replace(/[\t\n\v\f\r\u0085\u2028\u2029]+/g, ' ').replace(/\p{Cc}/gu, '').trim();
}
function cap(text: string): string {
  const f = fold(text);
  return [...f].length > 470 ? [...f].slice(0, 470).join('').trim() : f;
}

// ---------------------------------------------------------------- decisions

function decideInspect(view: View, a: Analysis, options: Seat[]): Seat | null {
  if (options.length === 0) return null;
  const inspected = new Set((view.seerResults ?? []).map((r) => r.seat));
  const fresh = options.filter((s) => !inspected.has(s));
  return topSuspect(a, fresh.length > 0 ? fresh : options);
}

function decideProtect(view: View, a: Analysis, options: Seat[]): Seat | null {
  if (options.length === 0) return null;
  const inOptions = (s: Seat) => options.includes(s);
  // A credible claimed seer is the wolves' first target.
  if (a.bestClaim && inOptions(a.bestClaim.claimer)) return a.bestClaim.claimer;
  for (const c of a.claims) {
    if (!c.fake && c.claimer !== view.you.seat && inOptions(c.claimer)) return c.claimer;
  }
  // Then a seat a claim cleared, then the strongest accuser of the top wolf
  // suspect (the voice the wolves most want gone).
  for (const c of a.claims) {
    for (const t of c.cleared) if (inOptions(t)) return t;
  }
  const suspect = topSuspect(a, aliveSeats(view).filter((s) => s !== view.you.seat));
  if (suspect != null) {
    const accusers = [...(a.accusedBy.get(suspect) ?? [])].filter(inOptions).sort((x, y) => x - y);
    if (accusers.length > 0) return accusers[0]!;
  }
  // Otherwise protect the most town-read living seat available.
  let best: Seat | null = null;
  let bestScore = Infinity;
  for (const s of [...options].sort((x, y) => x - y)) {
    const sc = a.scores.get(s) ?? 0;
    if (sc < bestScore) {
      bestScore = sc;
      best = s;
    }
  }
  return best;
}

function decideKill(view: View, a: Analysis, options: Seat[]): Seat | null {
  if (options.length === 0) return null;
  // Unanimity: if my partner already named someone tonight, match it.
  // Night n is served with day n in the view, and wolfVotes carries every
  // night, so only an entry from tonight (night === view.day) counts; a
  // target from an earlier night must never be matched by accident.
  for (const v of view.wolfVotes ?? []) {
    if (v.night === view.day && v.seat !== view.you.seat && v.target != null && options.includes(v.target)) {
      return v.target;
    }
  }
  // Wait-one-night on a freshly claimed seer: a claim that first appeared in
  // yesterday's debate (claim day = view.day - 1, this being the night right
  // after it) will almost certainly be protected tonight, because the doctor
  // cannot protect the same seat twice in a row but can tonight. Unless the
  // doctor is known dead, spend tonight's kill elsewhere; next night the
  // cooldown makes the seer the top target again through the normal logic.
  const doctorKnownDead = [...a.revealed.values()].includes('doctor');
  const freshClaim = doctorKnownDead
    ? null
    : (a.claims.find(
        (c) => !c.fake && c.credibility >= 0.6 && c.wolfTargets.length > 0 && c.day === view.day - 1 && c.claimer !== view.you.seat && options.includes(c.claimer),
      ) ?? null);
  let killOptions = options;
  if (freshClaim) {
    // A seat that seer cleared first.
    for (const t of freshClaim.cleared) if (options.includes(t)) return t;
    // Then the seer's strongest vocal supporter: accused the named wolf, or
    // defended the claimer.
    let sup: Seat | null = null;
    let supScore = 0;
    for (const s of [...options].sort((x, y) => x - y)) {
      if (s === freshClaim.claimer) continue;
      let sc = 0;
      for (const t of freshClaim.wolfTargets) if (a.accusedBy.get(t)?.has(s)) sc += 1;
      if (a.defendedBy.get(freshClaim.claimer)?.has(s)) sc += 1;
      if (sc > supScore) {
        supScore = sc;
        sup = s;
      }
    }
    if (sup != null) return sup;
    killOptions = options.filter((s) => s !== freshClaim.claimer);
  }
  // A claimed seer first (counter-claimants included: one of them is real).
  const claimers = a.claims.filter((c) => !c.fake).map((c) => c.claimer).filter((s) => killOptions.includes(s)).sort((x, y) => x - y);
  if (claimers.length > 0) return claimers[0]!;
  const docClaim = [...a.doctorClaimers].filter((s) => killOptions.includes(s)).sort((x, y) => x - y);
  if (docClaim.length > 0) return docClaim[0]!;
  // Then whoever accuses me or my partner most directly.
  const threats = new Set<Seat>();
  for (const wolfSeat of [view.you.seat, view.you.partner?.seat ?? -1]) {
    for (const acc of a.accusedBy.get(wolfSeat) ?? []) if (killOptions.includes(acc)) threats.add(acc);
  }
  if (threats.size > 0) return [...threats].sort((x, y) => x - y)[0]!;
  // Then a cleared, town-trusted seat.
  for (const c of a.claims) for (const t of c.cleared) if (killOptions.includes(t)) return t;
  // Else the most town-read seat: killing a trusted voice helps most.
  let best: Seat | null = null;
  let bestScore = Infinity;
  for (const s of [...killOptions].sort((x, y) => x - y)) {
    const sc = a.scores.get(s) ?? 0;
    if (sc < bestScore) {
      bestScore = sc;
      best = s;
    }
  }
  return best;
}

function decideVote(view: View, a: Analysis, options: Seat[]): Seat | null {
  if (options.length === 0) return null;
  const me = view.you.seat;
  const isWolf = view.you.role === 'werewolf';
  const partner = view.you.partner?.seat ?? -1;

  let pick: Seat | null = null;

  if (!isWolf) {
    // My own seer result first.
    if (view.you.role === 'seer') {
      const found = [...a.knownWolves].filter((s) => options.includes(s)).sort((x, y) => x - y);
      if (found.length > 0) pick = found[0]!;
    }
    // A claim that names me is a fake claim: vote the claimant.
    if (pick == null) {
      const namingMe = a.claims.find((c) => c.claimer !== me && c.wolfTargets.includes(me));
      if (namingMe && options.includes(namingMe.claimer)) pick = namingMe.claimer;
    }
    // A credible seer claim's named werewolf.
    if (pick == null && a.bestClaim) {
      const t = a.bestClaim.wolfTargets.filter((s) => options.includes(s)).sort((x, y) => x - y);
      if (t.length > 0) pick = t[0]!;
    }
    if (pick == null) pick = topSuspect(a, options);
  } else {
    const namedBySeer = a.claims.some((c) => !c.fake && c.wolfTargets.includes(me));
    const partnerTally = a.votesToday.get(partner) ?? 0;
    if (options.includes(partner)) {
      // Tie-making before bussing. Votes are public and sequential: count
      // what is cast, and how many voters remain including me. If my partner
      // holds a unique plurality but the runner-up can still level the tally
      // by the end of the vote, back the runner-up and force the tie. Bus
      // only when the exile is mathematically unavoidable, or the partner
      // was named by a credible seer claim and already holds 3+ votes.
      const aliveCount = view.players.filter((p) => p.alive).length;
      const remaining = Math.max(1, aliveCount - a.votesCastToday);
      let runnerUp: Seat | null = null;
      let runnerTally = -1;
      for (const s of [...options].sort((x, y) => x - y)) {
        if (s === partner) continue;
        const t = a.votesToday.get(s) ?? 0;
        if (t > runnerTally || (t === runnerTally && runnerUp != null && (a.scores.get(s) ?? 0) > (a.scores.get(runnerUp) ?? 0))) {
          runnerTally = t;
          runnerUp = s;
        }
      }
      const partnerUnique = runnerUp == null || partnerTally > runnerTally;
      const namedCredible =
        (a.bestClaim?.wolfTargets.includes(partner) ?? false) ||
        a.claims.some((c) => !c.fake && c.credibility >= 0.6 && c.wolfTargets.includes(partner));
      const unavoidable = runnerUp == null ? partnerTally >= 1 : partnerTally > runnerTally + remaining;
      const bus = unavoidable || (namedCredible && partnerTally >= 3);
      if (partnerUnique && partnerTally >= 1 && runnerUp != null && !bus && runnerTally + remaining >= partnerTally) {
        pick = runnerUp; // make the tie, save the partner
      } else if (bus && partnerTally >= 1) {
        pick = partner; // exile unavoidable: bus for cover
      }
    }
    if (pick == null && namedBySeer) {
      const claimer = a.claims.find((c) => !c.fake && c.wolfTargets.includes(me))!.claimer;
      if (options.includes(claimer)) pick = claimer;
    }
    if (pick == null) {
      const exclude = new Set<Seat>([partner, me]);
      pick = topSuspect(a, options, exclude);
    }
  }

  if (pick == null) return null;
  // Plurality sense: votes are public and sequential. If a different seat is
  // already running away with it and is at least mildly suspect (and is not
  // a cleared seat or a credible seer), join it so the day exiles someone
  // rather than tying. Never join a run on my partner as a wolf unless the
  // bus case above already chose to.
  let leader: Seat | null = null;
  let leaderVotes = 0;
  for (const [seat, n] of a.votesToday) {
    if (n > leaderVotes && options.includes(seat)) {
      leaderVotes = n;
      leader = seat;
    }
  }
  if (leader != null && leader !== pick && leaderVotes >= 2) {
    const leaderScore = a.scores.get(leader) ?? 0;
    const pickScore = a.scores.get(pick) ?? 0;
    const leaderIsClaimer = a.bestClaim != null && a.bestClaim.claimer === leader;
    const forbidden = isWolf && leader === partner;
    if (!forbidden && !leaderIsClaimer && leaderScore > -40 && leaderScore >= pickScore - 25) {
      return leader;
    }
  }
  return pick;
}

/** The seer-claim statement: label first, every inspection result shared, and a lock instruction naming the target at the end. */
function seerClaimStatement(view: View, a: Analysis): string {
  const results = view.seerResults ?? [];
  const found = results.filter((r) => r.werewolf);
  const clears = results.filter((r) => !r.werewolf);
  const parts: string[] = ['SEER CLAIM: I am the seer.'];
  for (const f of found) parts.push(`On night ${f.night} I inspected ${nameOf(view, f.seat)} and they are a werewolf.`);
  if (clears.length > 0) parts.push(`I cleared ${clears.map((r) => `${shortOf(view, r.seat)} (night ${r.night})`).join(' and ')}.`);
  if (found.length === 0 && clears.length === 0) parts.push('I have no results yet.');
  let target: Seat | null = found.length > 0 ? found[0]!.seat : null;
  if (target == null) {
    const exclude = new Set<Seat>([view.you.seat, ...a.knownClear]);
    target = topSuspect(a, aliveSeats(view), exclude);
  }
  if (target != null) parts.push(`Lock your vote on ${nameOf(view, target)}.`);
  return cap(parts.join(' '));
}

function speakText(view: View, a: Analysis): string | null {
  const me = view.you.seat;
  const role = view.you.role;
  const day = view.day;
  const claimsNamingMe = a.claims.filter((c) => c.claimer !== me && c.wolfTargets.includes(me));
  const mySpeechesTotal = view.log.filter((e) => e.kind === 'speech' && e.seat === me).length;

  // --- Seer with a found werewolf: claim and push, every debate.
  if (role === 'seer') {
    const found = (view.seerResults ?? []).filter((r) => r.werewolf && view.players.find((p) => p.seat === r.seat)?.alive);
    if (found.length > 0) return seerClaimStatement(view, a);
    // Two further claim triggers, and no others:
    // (a) anti-mislynch: debate round 2, at least 2 distinct living seats
    //     accused me in today's speeches.
    // (b) critical day: round 1, 5 or 6 players alive, no werewolf revealed
    //     dead yet, and at least 2 inspection results to share.
    const results = view.seerResults ?? [];
    const round2 = a.currentRound >= 2 || a.speechesTodayByMe >= 1;
    const accusersToday = [...a.accusedMeToday].filter((s) => s !== me && view.players.find((p) => p.seat === s)?.alive).length;
    if (round2 && accusersToday >= 2) return seerClaimStatement(view, a);
    const aliveCount = view.players.filter((p) => p.alive).length;
    const wolfRevealedDead = [...a.revealed.values()].includes('werewolf');
    if (!round2 && (aliveCount === 5 || aliveCount === 6) && !wolfRevealedDead && results.length >= 2) {
      return seerClaimStatement(view, a);
    }
  }

  // --- Named by someone else's seer claim.
  if (claimsNamingMe.length > 0) {
    const claimer = claimsNamingMe[0]!.claimer;
    if (role === 'werewolf') {
      if (!a.iCounterClaimed) {
        // Counter-claim: name the claimant as my inspected werewolf.
        return cap(
          `That claim is false. I am the real seer, and I inspected ${nameOf(view, claimer)}: they are a werewolf. A wolf names me because I am close. Vote ${shortOf(view, claimer)} today.`,
        );
      }
      return cap(`I already told you: I am the seer and ${shortOf(view, claimer)} is the werewolf I found. Do not let a loud claim bury a result. Vote ${shortOf(view, claimer)}.`);
    }
    return cap(
      `${shortOf(view, claimer)} is lying about me, so that seer claim is fake and ${shortOf(view, claimer)} is very likely a werewolf. I am village. Vote ${shortOf(view, claimer)} today.`,
    );
  }

  // --- Second debate round: only speak with a real reason.
  const alreadySpokeToday = a.speechesTodayByMe >= 1;

  // --- Seer claiming late with only clears, to steer the vote.
  if (role === 'seer' && day >= 3) {
    const clears = (view.seerResults ?? []).filter((r) => !r.werewolf);
    const top = topSuspect(a, aliveSeats(view).filter((s) => s !== me));
    if (clears.length > 0 && top != null && a.knownClear.has(top)) {
      const alt = topSuspect(a, aliveSeats(view).filter((s) => s !== me && !a.knownClear.has(s))) ?? top;
      return cap(
        `SEER CLAIM: I am the seer. I have no werewolf yet, but I cleared ${clears.map((r) => shortOf(view, r.seat)).join(' and ')}, so do not exile ${shortOf(view, top)}. Lock your vote on ${nameOf(view, alt)}.`,
      );
    }
    if (!a.iClaimedSeer && clears.length >= 2 && day >= 4) {
      const alt = topSuspect(a, aliveSeats(view).filter((s) => s !== me && !a.knownClear.has(s)));
      return cap(
        `SEER CLAIM: I am the seer. No werewolf found yet, but ${clears.map((r) => shortOf(view, r.seat)).join(' and ')} are cleared by my inspections. Narrow the vote to the rest.${alt != null ? ` Lock your vote on ${nameOf(view, alt)}.` : ''}`,
      );
    }
  }

  // --- Doctor under heavy fire: claim to avoid a wasted exile.
  if (role === 'doctor') {
    const accusers = a.accusedBy.get(me)?.size ?? 0;
    if (accusers >= 2 && !alreadySpokeToday) {
      return cap(`Claiming now because exile would waste me: I am the doctor. I have been protecting quietly. Do not vote me, look at ${shortOf(view, topSuspect(a, aliveSeats(view).filter((s) => s !== me)) ?? me)} instead.`);
    }
  }

  // --- A credible claim exists: village endorses, wolf plays along or buses.
  if (a.bestClaim) {
    const c = a.bestClaim;
    const target = c.wolfTargets[0]!;
    if (!alreadySpokeToday) {
      if (role === 'werewolf' && target === view.you.partner?.seat) {
        return cap(`If ${shortOf(view, c.claimer)} is the seer, then ${shortOf(view, target)} is caught and I will vote there. I want to hear any counterclaim first.`);
      }
      if (role === 'werewolf') {
        return cap(`${shortOf(view, c.claimer)} claims seer and names ${nameOf(view, target)}. Nobody has counterclaimed, so I will vote ${shortOf(view, target)} today.`);
      }
      return cap(
        `${shortOf(view, c.claimer)} claims seer and names ${nameOf(view, target)} as a werewolf. No counterclaim so far, so I believe it. Vote ${shortOf(view, target)} today.`,
      );
    }
    return null;
  }

  // --- Countered claims: name the likelier liar.
  if (a.claims.filter((c) => !c.fake).length >= 2 && !alreadySpokeToday) {
    const claimers = a.claims.filter((c) => !c.fake).map((c) => c.claimer).filter((s) => s !== me);
    const liar = topSuspect(a, claimers);
    if (liar != null) {
      return cap(`Two seer claims cannot both be true. Of the claimants, ${nameOf(view, liar)} looks the fakest: ${reasonFor(a, liar)}. I lean to voting ${shortOf(view, liar)}.`);
    }
  }

  if (alreadySpokeToday) return null;

  // --- Plain evidence statement.
  const exclude = new Set<Seat>([me]);
  if (role === 'werewolf' && view.you.partner) exclude.add(view.you.partner.seat);
  if (role === 'seer') for (const s of a.knownClear) exclude.add(s);
  const top = topSuspect(a, aliveSeats(view), exclude);
  if (top == null) return null;
  const topScore = a.scores.get(top) ?? 0;
  if (day === 1 && topScore < 12 && mySpeechesTotal === 0) {
    const dawn = view.log.find((e) => e.kind === 'dawn' && e.day === day);
    if (dawn && dawn.died != null) {
      return cap(`Day 1: ${shortOf(view, dawn.died)} died last night and was a ${a.revealed.get(dawn.died) ?? 'player'}. Little is proven yet. I am watching voting patterns, and I will name my suspect next round.`);
    }
    return cap(`Day 1 and nobody died, which means the doctor likely saved the target. Little is proven yet. I am watching who pushes votes without reasons.`);
  }
  if (topScore < 8) return null;
  return cap(`My top suspect is ${nameOf(view, top)}: ${reasonFor(a, top)}. I will vote ${shortOf(view, top)} unless a seer claim changes it.`);
}

export function decideAct(p: Pending): Record<string, unknown> {
  const view = p.view;
  const a = analyze(view);
  const fallback: Record<string, unknown> =
    p.decision === 'speak' ? { game: p.game, decision: 'speak', pass: true } : { game: p.game, decision: p.decision, target: null };
  try {
    switch (p.decision) {
      case 'speak': {
        const text = speakText(view, a);
        if (text == null || text === '') return fallback;
        const max = p.max_chars ?? 500;
        const cut = [...text].length > max ? [...text].slice(0, max).join('').trim() : text;
        return { game: p.game, decision: 'speak', text: cut };
      }
      case 'vote':
        return { game: p.game, decision: 'vote', target: decideVote(view, a, p.options ?? []) };
      case 'kill':
        return { game: p.game, decision: 'kill', target: decideKill(view, a, p.options ?? []) };
      case 'protect':
        return { game: p.game, decision: 'protect', target: decideProtect(view, a, p.options ?? []) };
      case 'inspect':
        return { game: p.game, decision: 'inspect', target: decideInspect(view, a, p.options ?? []) };
    }
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------- the loop

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

export async function run(): Promise<void> {
  const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
  if (envUrl === '') throw new Error('MAKEFUN_ENV_URL is not set');
  const post = async (path: string, body: unknown): Promise<{ status: number; body: unknown }> => {
    const res = await fetch(`${envUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed };
  };

  const seen = new Set<string>();
  for (;;) {
    const obs = await post('/observe', {});
    if (obs.status !== 200 || !isRecord(obs.body)) throw new Error(`POST /observe answered ${obs.status}`);
    if (obs.body.done === true) break;
    const pending = (obs.body.pending as Pending[] | undefined) ?? [];
    for (const p of pending) {
      const key = `${p.game}:${p.decision}:${p.view.log.length}:${p.view.day}:${p.view.phase}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const act = decideAct(p);
      const posted = await post('/act', act);
      if (posted.status !== 200) {
        const fb =
          p.decision === 'speak' ? { game: p.game, decision: 'speak', pass: true } : { game: p.game, decision: p.decision, target: null };
        if (JSON.stringify(fb) !== JSON.stringify(act)) await post('/act', fb);
      }
    }
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    await run();
    process.exitCode = 0;
  } catch (err) {
    process.stderr.write(`werewolf-agent: ${(err as Error).stack ?? String(err)}\n`);
    process.exitCode = 1;
  }
}
