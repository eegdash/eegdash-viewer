// Deterministic byte-source fixtures shared across tests.
// `rampBytes(n)[i] === i & 0xff` — wrap-around byte ramp that's cheap
// to verify (any tested slice is a known function of its offset).

export function rampBytes(nBytes) {
  const b = new Uint8Array(nBytes);
  for (let i = 0; i < nBytes; i++) b[i] = i & 0xff;
  return b;
}

export function rampBlob(nBytes) {
  return new Blob([rampBytes(nBytes)]);
}
