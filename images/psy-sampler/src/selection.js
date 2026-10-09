// Which loop variants are on. `active` maps layer id -> variant id, so a layer
// can never have two variants at once. Pure: the UI owns the state, the
// engine only receives the lanes derived from it.

/**
 * Solo (default): a click replaces everything that was on; clicking the only
 * active variant turns it off. Combine: each click toggles that variant,
 * replacing a sibling of the same layer.
 */
export function pressVariant(active, layerId, variantId, combine) {
  const isOn = active[layerId] === variantId;
  if (combine) {
    const next = { ...active };
    if (isOn) delete next[layerId];
    else next[layerId] = variantId;
    return next;
  }
  return isOn && Object.keys(active).length === 1 ? {} : { [layerId]: variantId };
}

export const BG_KICK_VARIANT = "kick.punchy";

/**
 * Lanes the engine should be playing: the active variants plus the background
 * kick, which only fills in when some other layer is on and no kick variant is
 * selected (so it never doubles a kick and never plays on its own).
 */
export function desiredLanes(active, { bgKick }) {
  const lanes = { ...active };
  if (bgKick && Object.keys(active).length > 0 && !active.kick) {
    lanes.bgKick = BG_KICK_VARIANT;
  }
  return lanes;
}
