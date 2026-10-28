/**
 * The deterministic core of the investigation.
 *
 * Every function here is pure: it takes rows that came from Zetaris and
 * returns findings. No model is involved, which matters for two reasons.
 * First, the verdict is reproducible and testable without any network.
 * Second, when Nightshift is slow or returns a 502, the explanation prose
 * degrades but the ANSWER does not change.
 *
 * Causes are not ranked by hand-tuned weights. The primary cause is chosen by
 * counterfactual: we replay the stockout with one factor repaired at a time
 * and see which repair actually prevents it.
 */

const DAY_MS = 86_400_000;

export const addDays = (date: string, days: number): string =>
  new Date(Date.parse(date) + days * DAY_MS).toISOString().slice(0, 10);

export const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);

// --- inputs ----------------------------------------------------------------

export interface LedgerPoint {
  date: string;
  onHand: number;
}
export interface DemandPoint {
  date: string;
  units: number;
}
export interface PurchaseOrder {
  poId: string;
  supplierId: string;
  qtyOrdered: number;
  orderedDate: string;
  promisedDate: string;
  receivedDate: string | null;
}
export interface SupplierTerms {
  supplierId: string;
  supplierName: string;
  quotedLeadDays: number;
}
export interface Policy {
  reorderPoint: number;
  reorderQty: number;
}
export interface DeliveryRecord {
  poId: string;
  orderedDate: string;
  promisedDate: string;
  receivedDate: string;
}

export interface InvestigationInput {
  sku: string;
  trajectory: LedgerPoint[];
  demand: DemandPoint[];
  orders: PurchaseOrder[];
  supplier: SupplierTerms;
  policy: Policy;
  supplierHistory: DeliveryRecord[];
}

// --- outputs ---------------------------------------------------------------

export type CauseId =
  | 'supplier_lead_time_slip'
  | 'late_against_promise'
  | 'demand_increase'
  | 'reorder_point_too_low'
  | 'po_not_raised';

export type Verdict = 'supported' | 'rejected' | 'inconclusive';

export interface Finding {
  cause: CauseId;
  title: string;
  verdict: Verdict;
  /** A factual sentence, built from numbers rather than written by a model. */
  statement: string;
  numbers: Record<string, string | number | null>;
  /** True when repairing this factor alone would have prevented the stockout. */
  sufficient: boolean;
  /** True when the stockout still happens once this factor is repaired. */
  necessary: boolean;
}

export interface Episode {
  from: string;
  to: string;
  days: number;
}

export interface Investigation {
  sku: string;
  episode: Episode | null;
  /** The order that should have covered the gap. */
  coveringPo: PurchaseOrder | null;
  findings: Finding[];
  primary: Finding | null;
  secondary: Finding[];
  /** Assumptions a reader should see, stated rather than buried. */
  caveats: string[];
}

// --- episode detection -----------------------------------------------------

/** Contiguous runs of zero on-hand. */
export function findEpisodes(trajectory: LedgerPoint[]): Episode[] {
  const episodes: Episode[] = [];
  let run: LedgerPoint[] = [];
  const flush = () => {
    if (run.length > 0) {
      episodes.push({
        from: run[0]!.date,
        to: run.at(-1)!.date,
        days: run.length,
      });
      run = [];
    }
  };
  for (const point of trajectory) {
    if (point.onHand === 0) run.push(point);
    else flush();
  }
  flush();
  return episodes;
}

/**
 * The PO that was meant to cover the gap: the last one raised before the
 * stockout began that had not yet arrived when it began.
 */
export function findCoveringPo(
  orders: PurchaseOrder[],
  episode: Episode,
): PurchaseOrder | null {
  const candidates = orders
    .filter((order) => order.orderedDate <= episode.from)
    .filter(
      (order) => order.receivedDate === null || order.receivedDate >= episode.from,
    )
    .sort((a, b) => a.orderedDate.localeCompare(b.orderedDate));
  return candidates.at(-1) ?? null;
}

// --- demand estimation -----------------------------------------------------

/**
 * Observed sales understate demand during a stockout: you cannot sell what is
 * not on the shelf, so those days read as zero. Any counterfactual therefore
 * needs an estimate of what demand WOULD have been, taken from the days before
 * the shelf emptied.
 */
export function estimateDailyDemand(
  demand: DemandPoint[],
  trajectory: LedgerPoint[],
  window: { from: string; to: string },
): number {
  const stocked = new Set(
    trajectory.filter((point) => point.onHand > 0).map((point) => point.date),
  );
  const sample = demand.filter(
    (point) =>
      point.date >= window.from && point.date <= window.to && stocked.has(point.date),
  );
  if (sample.length === 0) return 0;
  return sample.reduce((sum, point) => sum + point.units, 0) / sample.length;
}

// --- counterfactual replay -------------------------------------------------

interface ReplayOptions {
  startDate: string;
  startOnHand: number;
  untilDate: string;
  arrivals: Map<string, number>;
  dailyDemand: (date: string) => number;
}

/**
 * The reorder-point crossing that should have triggered a given order: the
 * first day of the unbroken run at or below the reorder point that ends on or
 * before the order date.
 *
 * Stock oscillates across the reorder point all year, so the earliest dip in
 * the history says nothing about whether THIS order was raised promptly.
 */
export function findTriggeringCrossing(
  trajectory: LedgerPoint[],
  reorderPoint: number,
  orderedDate: string,
): LedgerPoint | null {
  const upToOrder = trajectory.filter((point) => point.date <= orderedDate);

  let lastBelow = -1;
  for (let i = upToOrder.length - 1; i >= 0; i -= 1) {
    if (upToOrder[i]!.onHand <= reorderPoint) {
      lastBelow = i;
      break;
    }
  }
  if (lastBelow === -1) return null;

  let start = lastBelow;
  while (start > 0 && upToOrder[start - 1]!.onHand <= reorderPoint) start -= 1;
  return upToOrder[start]!;
}

/** Replays stock forward; returns the first date it would hit zero, or null. */
export function replay(options: ReplayOptions): string | null {
  let onHand = options.startOnHand;
  let date = options.startDate;

  while (date <= options.untilDate) {
    const arriving = options.arrivals.get(date);
    if (arriving !== undefined) onHand += arriving;

    onHand -= options.dailyDemand(date);
    if (onHand <= 0) return date;

    date = addDays(date, 1);
  }
  return null;
}

// --- the investigation -----------------------------------------------------

/** Ratio thresholds, stated once so the report can cite them. */
export const DEMAND_SPIKE_RATIO = 1.5;

export function investigate(input: InvestigationInput): Investigation {
  const caveats: string[] = [];
  const episodes = findEpisodes(input.trajectory);

  if (episodes.length === 0) {
    return {
      sku: input.sku,
      episode: null,
      coveringPo: null,
      findings: [],
      primary: null,
      secondary: [],
      caveats: [`${input.sku} never reached zero stock in the period examined.`],
    };
  }
  if (episodes.length > 1) {
    caveats.push(
      `${episodes.length} separate stockouts occurred; this report examines the ` +
        `longest one.`,
    );
  }

  const episode = [...episodes].sort((a, b) => b.days - a.days)[0]!;
  const coveringPo = findCoveringPo(input.orders, episode);

  const onHandBy = new Map(
    input.trajectory.map((point) => [point.date, point.onHand] as const),
  );

  // Demand before the shelf emptied, used for every counterfactual.
  const baselineWindow = { from: addDays(episode.from, -90), to: addDays(episode.from, -29) };
  const recentWindow = { from: addDays(episode.from, -28), to: addDays(episode.from, -1) };
  const baselineDemand = estimateDailyDemand(input.demand, input.trajectory, baselineWindow);
  const recentDemand = estimateDailyDemand(input.demand, input.trajectory, recentWindow);
  const demandRatio = baselineDemand === 0 ? null : recentDemand / baselineDemand;

  caveats.push(
    `Demand during the stockout is estimated at ${recentDemand.toFixed(1)} ` +
      `units/day from the 28 days before it began, because sales records show ` +
      `zero while the shelf was empty and so understate real demand.`,
  );

  const findings: Finding[] = [];

  // --- cause: supplier lead-time slip --------------------------------------
  if (coveringPo) {
    const actualLead =
      coveringPo.receivedDate === null
        ? null
        : daysBetween(coveringPo.orderedDate, coveringPo.receivedDate);
    const quoted = input.supplier.quotedLeadDays;
    const slipped = actualLead !== null && actualLead > quoted;

    // Counterfactual: the same order, arriving on the quoted lead time.
    const startOnHand = onHandBy.get(coveringPo.orderedDate) ?? 0;
    const asQuotedArrival = addDays(coveringPo.orderedDate, quoted);
    const horizon = coveringPo.receivedDate ?? episode.to;

    const withQuotedLead = replay({
      startDate: addDays(coveringPo.orderedDate, 1),
      startOnHand,
      untilDate: horizon,
      arrivals: new Map([[asQuotedArrival, coveringPo.qtyOrdered]]),
      dailyDemand: () => recentDemand,
    });

    findings.push({
      cause: 'supplier_lead_time_slip',
      title: 'The supplier took longer than its quoted lead time',
      verdict: slipped ? 'supported' : 'rejected',
      statement: slipped
        ? `${coveringPo.poId} was raised on ${coveringPo.orderedDate} and arrived ` +
          `${coveringPo.receivedDate}, which is ${actualLead} days against a quoted ` +
          `${quoted}. Had it arrived within the quoted ${quoted} days, on ` +
          `${asQuotedArrival}, stock would not have reached zero.`
        : `${coveringPo.poId} arrived in ${actualLead ?? 'n/a'} days against a quoted ` +
          `${quoted}, which is within terms.`,
      numbers: {
        po: coveringPo.poId,
        ordered: coveringPo.orderedDate,
        received: coveringPo.receivedDate,
        actual_lead_days: actualLead,
        quoted_lead_days: quoted,
        excess_days: actualLead === null ? null : actualLead - quoted,
      },
      // Repairing the lead time alone prevents the stockout.
      sufficient: slipped && withQuotedLead === null,
      necessary: slipped,
    });

    // --- cause: late against its own promise -------------------------------
    const lateDays =
      coveringPo.receivedDate === null
        ? null
        : daysBetween(coveringPo.promisedDate, coveringPo.receivedDate);
    findings.push({
      cause: 'late_against_promise',
      title: 'The delivery missed its promised date',
      verdict: lateDays !== null && lateDays > 0 ? 'supported' : 'rejected',
      statement:
        lateDays !== null && lateDays > 0
          ? `${coveringPo.poId} was promised for ${coveringPo.promisedDate} and ` +
            `arrived ${coveringPo.receivedDate}, ${lateDays} days late.`
          : `${coveringPo.poId} arrived on or before its promised date.`,
      numbers: {
        po: coveringPo.poId,
        promised: coveringPo.promisedDate,
        received: coveringPo.receivedDate,
        days_late: lateDays,
      },
      sufficient: false,
      necessary: lateDays !== null && lateDays > 0,
    });

    // --- cause: demand increase -------------------------------------------
    // Counterfactual: baseline demand, but the delivery still arrives late.
    const withBaselineDemand = replay({
      startDate: addDays(coveringPo.orderedDate, 1),
      startOnHand,
      untilDate: horizon,
      arrivals:
        coveringPo.receivedDate === null
          ? new Map()
          : new Map([[coveringPo.receivedDate, coveringPo.qtyOrdered]]),
      dailyDemand: () => baselineDemand,
    });

    const spiked = demandRatio !== null && demandRatio >= DEMAND_SPIKE_RATIO;
    findings.push({
      cause: 'demand_increase',
      title: 'Demand rose before the stockout',
      verdict: demandRatio !== null && demandRatio > 1.05 ? 'supported' : 'rejected',
      statement:
        demandRatio === null
          ? 'There is not enough sales history to compare demand.'
          : `Demand averaged ${recentDemand.toFixed(1)} units/day in the 28 days ` +
            `before the stockout against ${baselineDemand.toFixed(1)} in the 90 to ` +
            `29 days before it, a ratio of ${demandRatio.toFixed(2)}. That is ` +
            `${spiked ? 'at or above' : 'below'} the ${DEMAND_SPIKE_RATIO} threshold ` +
            `for a spike. ` +
            // Name the lower rate outright: "at the earlier rate" alone was
            // read back by the model as "even at the higher rate".
            (withBaselineDemand === null
              ? `At the earlier, lower rate of ${baselineDemand.toFixed(1)} units/day ` +
                `the shelf would have held, so the rise alone does not account ` +
                `for the stockout.`
              : `Even at the earlier, lower rate of ${baselineDemand.toFixed(1)} ` +
                `units/day, with the same late delivery, the shelf would still have ` +
                `emptied, so the rise alone does not account for the stockout.`),
      numbers: {
        recent_units_per_day: Number(recentDemand.toFixed(2)),
        baseline_units_per_day: Number(baselineDemand.toFixed(2)),
        ratio: demandRatio === null ? null : Number(demandRatio.toFixed(3)),
        spike_threshold: DEMAND_SPIKE_RATIO,
      },
      sufficient: false,
      // Necessary only if repairing demand prevents the stockout.
      necessary: withBaselineDemand === null,
    });

    // --- cause: reorder point too low -------------------------------------
    const neededForQuoted = recentDemand * quoted;
    const adequate = input.policy.reorderPoint >= neededForQuoted;
    findings.push({
      cause: 'reorder_point_too_low',
      title: 'The reorder point was too low for the lead time',
      verdict: adequate ? 'rejected' : 'supported',
      statement: adequate
        ? `The reorder point of ${input.policy.reorderPoint} units covers ` +
          `${quoted} days at ${recentDemand.toFixed(1)} units/day ` +
          `(${neededForQuoted.toFixed(0)} units needed), so the policy was sound ` +
          `for the quoted lead time.`
        : `The reorder point of ${input.policy.reorderPoint} units does not cover ` +
          `${quoted} days at ${recentDemand.toFixed(1)} units/day ` +
          `(${neededForQuoted.toFixed(0)} units needed).`,
      numbers: {
        reorder_point: input.policy.reorderPoint,
        needed_for_quoted_lead: Number(neededForQuoted.toFixed(0)),
        quoted_lead_days: quoted,
      },
      sufficient: false,
      necessary: !adequate,
    });

    // --- cause: no PO raised in time --------------------------------------
    // The crossing that should have triggered THIS order is the start of the
    // run of days at or below the reorder point that precedes it, not the
    // first dip anywhere in the history.
    const crossing = findTriggeringCrossing(
      input.trajectory,
      input.policy.reorderPoint,
      coveringPo.orderedDate,
    );
    const gap =
      crossing === null ? null : daysBetween(crossing.date, coveringPo.orderedDate);
    findings.push({
      cause: 'po_not_raised',
      title: 'No order was raised when stock crossed the reorder point',
      verdict: gap !== null && gap > 2 ? 'supported' : 'rejected',
      statement:
        crossing === null
          ? 'Stock never crossed the reorder point before the stockout.'
          : `Stock crossed the reorder point on ${crossing.date} and ` +
            `${coveringPo.poId} was raised on ${coveringPo.orderedDate}, ` +
            `${gap} day(s) later.`,
      numbers: {
        crossed_on: crossing?.date ?? null,
        ordered_on: coveringPo.orderedDate,
        gap_days: gap,
      },
      sufficient: false,
      necessary: gap !== null && gap > 2,
    });
  } else {
    caveats.push(
      'No purchase order covering the stockout was found, so delivery causes ' +
        'could not be tested.',
    );
  }

  // --- choose the primary cause by counterfactual, not by weight -----------
  const supported = findings.filter((finding) => finding.verdict === 'supported');
  const primary =
    supported.find((finding) => finding.sufficient) ??
    supported.find((finding) => finding.necessary) ??
    supported[0] ??
    null;
  const secondary = supported.filter((finding) => finding !== primary);

  return { sku: input.sku, episode, coveringPo, findings, primary, secondary, caveats };
}
