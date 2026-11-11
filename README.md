# Werewolf Agent

A deterministic, rule-based agent for 8-player Werewolf, built for the
make.fun bounty `werewolf-agent-01`. It makes no model calls: every decision
is a pure function of that game's view served by the env at
`MAKEFUN_ENV_URL`, so a trial replays byte for byte.

Run it the way the grader does:

```sh
node /bot/main.ts
```

Node 22, standard library only.

## How it plays

- Parses every public statement for seer claims (named werewolves and
  cleared seats), accusations, defences and doctor claims, and scores every
  seat from public facts: revealed roles, exile votes, votes cast with a
  revealed werewolf, defences of a revealed werewolf, night victims'
  accusations, and silence.
- Seer: inspects the most suspicious uninspected seat, claims with all
  results shared when a werewolf is found, when a mislynch is coming in
  round 2, or on a critical day with 5-6 players alive.
- Doctor: protects a credible claimed seer first, then cleared seats and
  strong accusers of the top suspect.
- Villager: follows an uncountered seer claim; otherwise votes the highest
  suspicion seat and joins a plurality when that secures an exile.
- Werewolf: matches the partner's kill pick for unanimity, waits one night
  on a freshly claimed seer (the doctor's protection cooldown), counter-
  claims only when named by a seer claim, makes a tie to save the partner
  before bussing, and buses only when the exile is unavoidable.

MIT licensed, see `LICENSE`.
