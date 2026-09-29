const FRACTION = /\.(\d+)(?=Z|[+-]\d{2}:\d{2}$)/;

type ParsedTimestamp = { epochSecond: bigint; fraction: string };

function parseTimestamp(value: string): ParsedTimestamp | null {
  if (typeof value !== 'string') return null;
  const match = value.match(FRACTION);
  const wholeSecond = match === null ? value : value.replace(FRACTION, '');
  const epochMilliseconds = Date.parse(wholeSecond);
  if (!Number.isFinite(epochMilliseconds)) return null;
  return {
    epochSecond: BigInt(epochMilliseconds) / 1000n,
    fraction: match?.[1]?.replace(/0+$/, '') ?? '',
  };
}

export function compareRfc3339Timestamps(left: string, right: string): number {
  const leftTimestamp = parseTimestamp(left);
  const rightTimestamp = parseTimestamp(right);
  if (leftTimestamp === null || rightTimestamp === null) return Number.NaN;
  if (leftTimestamp.epochSecond !== rightTimestamp.epochSecond) {
    return leftTimestamp.epochSecond < rightTimestamp.epochSecond ? -1 : 1;
  }

  const precision = Math.max(leftTimestamp.fraction.length, rightTimestamp.fraction.length);
  for (let index = 0; index < precision; index++) {
    const leftDigit = leftTimestamp.fraction.charCodeAt(index) || 48;
    const rightDigit = rightTimestamp.fraction.charCodeAt(index) || 48;
    if (leftDigit !== rightDigit) return leftDigit < rightDigit ? -1 : 1;
  }
  return 0;
}
