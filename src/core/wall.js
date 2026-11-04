// Wall geometry shared by UI, detection and calibration.

/** Rectified wall resolution (pixels) for a physical size in metres. */
export function wallSize(widthM, heightM) {
  const aspect = Math.max(0.2, Math.min(5, widthM / heightM));
  let RH = 1000, RW = Math.round(RH * aspect);
  if (RW > 1500) { RW = 1500; RH = Math.round(RW / aspect); }
  return { RW, RH, aspect, pxPerCm: RH / (heightM * 100) };
}
