# Stockout Why

**An agent that explains why a product ran out of stock, and cites the rows behind every claim.**

Open Agent Hackathon 2026 · Track 2, *The Agent That Can Explain Why* ·

Demo link: [youtu.be/zfszTeOsPOo](https://youtu.be/zfszTeOsPOo)

---

## The problem

A shop owner notices an empty shelf and asks the only question that matters: *why?*
The answer is sitting in four different places — till receipts, the stock ledger,
purchase orders, and the supplier's agreed terms — and nobody has time to line them
up by hand. So the usual answer is a guess: "demand was up," or "the supplier let us
down," with nothing to tell the two apart.

Guessing wrong is expensive. If you blame demand, you raise the reorder point and tie
up cash that was never the problem. If you blame the supplier, you start a negotiation
you may not be able to justify.

## What it does

Ask it about a SKU and it returns a verdict, the reasoning, and the evidence:

```
  PRIMARY CAUSE
    The supplier took longer than its quoted lead time

    PO-506 was raised on 2026-08-23 and arrived 2026-09-11, which is 19
    days against a quoted 7. Had it arrived within the quoted 7 days, on
    2026-08-30, stock would not have reached zero.

    This is the primary cause because repairing it alone - and nothing
    else - would have prevented the stockout.

  CONTRIBUTING, BUT NOT SUFFICIENT ON ITS OWN
    [supported] Demand rose before the stockout
      Demand averaged 32.8 units/day in the 28 days before the
      stockout against 27.5 in the 90 to 29 days before it, a ratio of
      1.20. That is below the 1.5 threshold for a spike. At the
      earlier rate the shelf would have emptied anyway, so the rise
      alone does not account for the stockout.

  RULED OUT
    [ruled out] The reorder point was too low for the lead time
      The reorder point of 336 units covers 7 days at 32.8 units/day
      (230 units needed), so the policy was sound for the quoted lead
      time.
```

Note what it does *not* do: demand genuinely rose, and a system that scored causes by
plausibility would have blamed it. This one reports the rise, then shows why it is not
the explanation.

## How it decides — counterfactuals, not weights

Most "root cause" tools rank candidate causes with hand-tuned weights, which means the
ranking is really the author's hunch in numeric clothing.

This one replays history with **one factor repaired at a time** and asks which repair
actually prevents the stockout:

| Repair                                       | Outcome                | Conclusion                          |
| -------------------------------------------- | ---------------------- | ----------------------------------- |
| The delivery arrives on its quoted lead time | Stock never hits zero  | The slip is **sufficient**    |
| Demand stays at its earlier baseline         | Stock hits zero anyway | The rise is **not necessary** |

A cause is primary when repairing it alone would have prevented the outcome. That is a
claim about the data, not a preference, and you can check it.

One subtlety the replay has to handle: **sales records understate demand during a
stockout**, because you cannot sell from an empty shelf. Those days read as zero. So the
counterfactual uses demand measured from the 28 days *before* the shelf emptied, and the
report states that assumption rather than burying it.

## The three layers

### DATA — Zetaris

Zetaris's semantic layer is the agent's only door to the data. It never touches a source
directly, and it cannot compose its own SQL: [src/queries.ts](src/queries.ts) is a fixed
allowlist of seven named, read-only queries. A model may choose *which* to run and with
what parameters; it cannot invent one.

Every read returns an `Evidence` record — the SQL, the columns, the rows, a result hash,
and a timestamp ([src/zetaris.ts](src/zetaris.ts)) — so each claim in the report can name
the query behind it and anyone can re-run it.

Six tables across the four sources a retailer actually keeps: `suppliers`, `products`,
`inventory_policy`, `sales_daily`, `stock_ledger`, `purchase_orders`. They live where a
shop's data really lives, in an operational database (a Postgres container,
[infra/retail-db.compose.yml](infra/retail-db.compose.yml)). Zetaris registers that
database as a datasource and reads it in place, so the agent queries `retail.stock_ledger`
through Zetaris and has no connection to the database itself.

### BUILD — Meterless H-MEM

**Engine implemented: H-MEM.** Not vendored — [src/hmem/](src/hmem/) is an implementation
written against the published spec, and it passes the upstream conformance suite
**13/13** on the canonical runner ([scorecard](docs/hmem-conformance.txt)).

The working feature is memory that compounds. When an investigation reaches a verdict, it
is written to memory with its lineage. The *next* investigation of that supplier recalls
it first:

```
  REMEMBERED FROM EARLIER INVESTIGATIONS            [H-MEM]
    SKU-1041 from SUP-01 ran out for 8 days from 2026-09-03. Primary
    cause: supplier_lead_time_slip. PO-506 was raised on 2026-08-23...
      confidence 0.75  mem_099e4633-8777-4102-baa7-bd59dddc87c9
```

An analyst's verdict feeds back through the engine's own feedback deltas, so a confirmed
conclusion ranks higher next time and a rejected one is flagged for review:

```
$ npm run investigate -- --confirm mem_099e... --verdict confirmed
Recorded "confirmed": confidence 0.70 -> 0.75
```

The rules the implementation honours, each from the spec rather than invented here:

- a record without a `source` is rejected by construction
- feedback deltas are exactly `helpful +0.05` (and `+1` access), `not_helpful −0.03`,
  `wrong −0.20` plus a `review` tag, clamped to `[0,1]`
- the eight-signal ranking blend, clamped and *then* multiplied by confidence, with the
  `−0.20` superseded penalty
- archive only at ≥30 days old, `accessCount ≤2`, and unreferenced; never archive a
  derived record
- auto-resolve a conflict only at decision confidence ≥0.70; the loser is marked
  `supersededBy` and **never deleted**
- dream proposals never materialise before approval
- no mutation happens without a trust ledger entry

### POWER — Meterless Nightshift and NVIDIA Nemotron

Nightshift is the app's primary AI provider ([src/nightshift.ts](src/nightshift.ts)),
reached over the OpenAI-compatible contract with `meterless-app` and `meterless-scope`
headers. The provider key lives in Nightshift's Providers tab, never in this repo. On the
verified setup Nightshift reaches Nemotron 3.5 Lightning through its OpenRouter provider
(NVIDIA's own key needs a phone check that isn't offered in every country), and the app
pins it with `METERLESS_MODEL=openrouter/nvidia/nemotron-3.5-lightning`.

Nemotron's job is deliberately bounded: **it writes the explanation, it does not reach
the verdict.** Two consequences, both on purpose:

1. A Nightshift outage degrades the prose, not the answer. The report says so plainly and
   publishes the deterministic wording instead.
2. Every figure the model writes is checked against the findings before publishing
   ([src/verify.ts](src/verify.ts)). A narrative containing a number that is not in the
   evidence is **discarded**, not shown with a caveat.

Because `meterless/auto` can route to a non-NVIDIA model when several are eligible, the
report logs the model that *actually* answered and its receipt, rather than the one that
was requested:

```
  MODEL CALL
    requested  openrouter/nvidia/nemotron-3.5-lightning
    answered   openrouter/nvidia/nemotron-3.5-lightning
    receipt    rcpt_req_njbl9j0q
    latency    6061 ms
    nemotron   yes
```

## How one question flows

```
  "Why did SKU-1041 run out?"
            |
            v
  [1] DATA    seven named read-only queries -> Zetaris semantic layer
            |            each returns SQL + rows + result hash
            v
  [2] CORE    deterministic counterfactual replay        (no model)
            |            -> primary cause, secondary, ruled out
            v
  [3] BUILD   H-MEM: recall priors for this supplier, write this verdict
            |
            v
  [4] POWER   Nemotron via Nightshift writes the prose
            |            -> every figure checked against the evidence
            v
  verdict + reasoning + re-runnable evidence
```

## Running it

### Sample mode — no network, no keys, no Zetaris

```bash
npm install
npm run gen-data
npm run investigate -- --sku SKU-1041 --sample
```

Sample mode reads generated CSVs locally. It exists so the tests are reproducible from a
clean clone and the demo has a fallback. **It is not a substitute for the Data layer** —
the live path is Zetaris.

### Live mode — through Zetaris

```bash
cp .env.example .env     # then fill it in
npx tsx scripts/register_zetaris.ts --execute
npm run smoke
npm run investigate -- --sku SKU-1041 --explain
```

`.env` needs the Zetaris REST URL (`http://localhost:8888/api/v1.0` on a local install —
the API port, not the web UI), org id and API key, plus the Nightshift base URL and
Runtime token from its Console. If Zetaris runs on a different machine, use that
machine's reachable address, not `localhost`.

`register_zetaris.ts --execute` starts the retail database on the Zetaris Docker network,
loads the six tables, registers it in Zetaris (`CREATE DATASOURCE retail`, then
`REGISTER DATASOURCE TABLES FROM retail`), and counts every table back through Zetaris
against the CSVs. Without `--execute` it only writes the SQL and prints the plan.

On Windows PowerShell, `npm run investigate -- --sku ...` loses the `--` and npm swallows
`--sku`. Run the CLI directly there: `npx tsx src/cli.ts --sku SKU-1041 --explain`.

### The dataset

`npm run gen-data` simulates 180 days of trading day by day: demand draws down stock, the
reorder policy raises a purchase order when stock crosses the reorder point, and stock
only returns when an order is actually received. Sales, on-hand and deliveries therefore
cannot contradict one another, and the stockout's timing and length are *consequences*
rather than constants.

One fault is injected (a single PO at 19 days against 7 quoted) and one distractor (a
1.3× demand lift). The generator then **asserts its own scenario** — exactly one stockout
episode, no other SKU affected, the fault PO raised before the stockout began and
arriving the day it ended — and refuses to write a dataset that tells two stories.

The ground truth it derives goes to `data/generated/ground_truth.json`, which the tests
grade against.

## Tests

```bash
npm test
```

`npm test` regenerates the (seeded, deterministic) dataset first, so it works from a clean
clone with no extra steps.

| Suite                                                           | What it covers                                                                                                    |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| [tests/hmem.conformance.test.ts](tests/hmem.conformance.test.ts) | All 13 upstream conformance cases, reading the official `vectors.json`                                          |
| [tests/analysis.test.ts](tests/analysis.test.ts)                 | The investigation graded against the simulation's ground truth, including that it is not fooled by the distractor |
| [tests/memory.test.ts](tests/memory.test.ts)                     | The H-MEM feature end to end: recall across sessions, persistence on disk, feedback deltas, ranking               |
| [tests/verify.test.ts](tests/verify.test.ts)                     | The claim checker: dates in words, ordinals, thousands and loose identifiers are read, then held to the evidence  |

The local suite mirrors the upstream assertions. The canonical upstream runner has also
been run against this implementation and passes 13/13 —
[docs/hmem-conformance.txt](docs/hmem-conformance.txt) is its output. To reproduce it:

```bash
git clone --depth 1 --filter=blob:none --sparse \
  https://github.com/Meterless/Meterless.git vendor/meterless
cd vendor/meterless && git sparse-checkout set engines/hmem && cd ../..

HMEM_IMPL="$PWD/src/hmem/index.ts" \
  npx tsx vendor/meterless/engines/hmem/conformance/runner.ts
```

## Honest limits

- **The live Zetaris path is verified on a local install only.** Against the Zetaris
  platform running in Docker, the loader registers the retail database over REST, every
  table's row count read back through Zetaris matches the CSVs, `npm run smoke` passes its
  DATA checks, and a live `investigate --sku SKU-1041` reaches the same verdict, word for
  word, as sample mode, citing six Zetaris queries. It has not been run against a hosted
  Zetaris. Zetaris needs 8 GB given to Docker and 15 GB of disk.
- **`--explain` is verified against a live Nightshift.** `npm run smoke` passes 6/6, and a
  live `investigate --sku SKU-1041 --explain` gets its explanation from Nemotron 3.5
  Lightning, with every figure passing the claim checker. Timing varies with the upstream
  provider OpenRouter picks: some honour the prompt's `/no_think` and answer in ~6 seconds,
  others reason first (up to ~2 minutes) or occasionally return nothing. The app allows
  for reasoning in its token budget, never publishes a cut-off reply, retries an empty or
  cut-off one up to three times, and shows `attempts` in the MODEL CALL block when it did.
- **The claim checker checks figures, not wording.** It stops an invented number or date,
  but not a correct number placed in a loosely worded sentence; that is why the
  deterministic findings are always printed above the model's prose.
- Everything in sample mode — the investigation, the counterfactuals, H-MEM recall and
  feedback, the claim checker, all 13 conformance cases — **is** verified and reproducible
  from a clean clone.
- The data is synthetic. The reasoning is real and the numbers trace to rows, but no claim
  is made about accuracy on a real retailer's books.
- Only one fault type is injected. The five causes the agent tests are each exercised, but
  only the lead-time slip is exercised *as the true cause*.
- The embedder is a local bag-of-words projection, so H-MEM recall matches on shared
  vocabulary rather than paraphrase.

## Declarations

- **Pre-existing components: none.** All code in `src/`, `data/`, `scripts/` and `tests/`
  was written during the build window.
- **`vendor/`** is a sparse checkout of the Apache-2.0 licensed
  [Meterless](https://github.com/Meterless/Meterless) repository, used as the H-MEM
  specification and conformance vectors. It is gitignored and not part of this work. One
  file from it, the official conformance vectors, is committed unmodified as
  [tests/fixtures/hmem-vectors.json](tests/fixtures/hmem-vectors.json) (with its licence
  and a [notice](tests/fixtures/NOTICE.md)) so the tests run from a clean clone.
- **AI coding tool: Claude Code** (the organisers' 22 October update made Cursor
  optional). It was used throughout: to read the H-MEM spec and conformance runner, write
  the implementation, and build the investigation core. Two bugs it found and fixed in its
  own work are worth naming, since they are the kind that survive to a demo — an
  incoherent first dataset (a PO raised *on* the stockout day, and sales resuming before
  stock arrived), and a reorder-point check that matched the *first* dip in the whole
  history rather than the crossing that triggered the order.
- No API key, token or credential is committed. `.env` is gitignored; provider keys
  (NVIDIA, OpenRouter) belong in Nightshift's Providers tab.

## Layout

```
src/
  queries.ts      DATA   the fixed allowlist of read-only Zetaris queries
  zetaris.ts      DATA   REST client; every read returns an Evidence record
  analysis.ts     CORE   deterministic counterfactual reasoning (pure)
  sources.ts      CORE   assembles input from Zetaris, or from CSVs
  hmem/           BUILD  the H-MEM engine implementation
  nightshift.ts   POWER  Meterless provider; logs the routed model
  verify.ts       POWER  rejects model prose containing unsupported figures
  investigate.ts         orchestration, end to end
  report.ts              renders the verdict, reasoning and evidence
  cli.ts                 entry point
data/generate.ts         the self-validating simulation
infra/                   the retail database Zetaris federates (Docker Compose)
scripts/                 Zetaris loader, setup smoke test
```

## Author

**Sohaib Aamir** · [LinkedIn](https://www.linkedin.com/in/sohaib-aamir) · Pakistan

AI Backend Engineer at NCAI, NUST, and MS Computer Science student at NUST (2025–2027).
I build AI systems that have to work on real, messy data, and I measure where they fail.
My work covers agentic AI, multimodal document understanding and on-premises LLM serving.

- 1st place, AI for Connectivity Hackathon 2025
- Global Nominee, NASA Space Apps 2024
- All 9 puzzles solved, Harvard CS50x Puzzle Day 2025
