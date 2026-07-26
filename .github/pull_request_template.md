<!-- Please write PR descriptions and commit messages in English. -->

## What this changes

## Why

<!-- If it fixes a bug, describe the failure mode rather than just naming the fix.
     If it adds a capability, say how its value can be measured — see ROADMAP.md:
     features whose value can't be measured don't get scheduled. -->

## Verification

- [ ] `npx tsc --noEmit -p apps/server && npx tsc --noEmit -p packages/bench`
- [ ] `npm test` — engine unit tests
- [ ] `npm test -w packages/bench` — grader self-tests
- [ ] `npm run bench:resilience -w packages/bench` — 4/4

<!-- Ran the scored bench? Paste the before/after numbers, including sample size.
     Negative results are welcome and expected — two features in this repo are
     documented as "works, but not shown to be worth it". -->

## Notes for the reviewer

<!-- Anything that looks simplifiable but isn't; boundaries you deliberately left in place. -->
