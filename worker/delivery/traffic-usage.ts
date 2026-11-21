// Quota lives on plans.traffic_gb and the subscription snapshot traffic_gb.
// Nothing in D1, KV, or node import stores bytes this subscription has carried.
// SIP008 bytes_used / bytes_remaining are dropped at import and describe the
// upstream server, so they are not a measurement for this user.

/** Same GB the admin types into trafficGb. 1 GB = 1024^3 bytes. */
export const BYTES_PER_TRAFFIC_GB = 1024 ** 3

export type MeasuredTraffic = {
  uploadBytes: number
  downloadBytes: number
}

export type TrafficUsage = {
  usedGb: number
  /** Null when trafficGb is 0, which already means an unlimited quota. */
  remainingGb: number | null
}

function wholeBytes(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

export function trafficUsageFromMeasurement(
  trafficGb: number,
  measurement: MeasuredTraffic | null,
): TrafficUsage | null {
  if (measurement === null) return null
  if (!Number.isFinite(trafficGb) || trafficGb < 0) return null
  const { uploadBytes, downloadBytes } = measurement
  if (!wholeBytes(uploadBytes) || !wholeBytes(downloadBytes)) return null
  if (uploadBytes > Number.MAX_SAFE_INTEGER - downloadBytes) return null
  const usedGb = (uploadBytes + downloadBytes) / BYTES_PER_TRAFFIC_GB
  const remainingGb = trafficGb === 0 ? null : Math.max(0, trafficGb - usedGb)
  return { usedGb, remainingGb }
}

/** No meter is wired. Null keeps usedGb and remainingGb off the payload. */
export function measuredTrafficForSubscription(subscriptionId: string | null): MeasuredTraffic | null {
  void subscriptionId
  return null
}

export function attachTrafficUsage<T extends object>(
  body: T,
  trafficGb: number,
  measurement: MeasuredTraffic | null,
): T | (T & TrafficUsage) {
  const usage = trafficUsageFromMeasurement(trafficGb, measurement)
  if (!usage) return body
  return { ...body, usedGb: usage.usedGb, remainingGb: usage.remainingGb }
}
