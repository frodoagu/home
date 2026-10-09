// Which loop variants are on. `active` maps lane key -> variant id. Pure: the
// UI owns the state, the engine only receives the lanes derived from it.

/**
 * Lane a variant plays on. Exclusive layers (kick, bass) have one lane, so a
 * second variant replaces the first: two kicks or two basses only muddy. The
 * rest stack: each variant is its own lane (hat + clap + toms at once).
 */
export const laneKey = (layer, variantId) => (layer.exclusive ? layer.id : variantId);

/**
 * Solo (default): a click replaces everything that was on; clicking the only
 * active variant turns it off. Combine: each click toggles that variant,
 * replacing whatever shares its lane.
 */
export function pressVariant(active, key, variantId, combine) {
  const isOn = active[key] === variantId;
  if (combine) {
    const next = { ...active };
    if (isOn) delete next[key];
    else next[key] = variantId;
    return next;
  }
  return isOn && Object.keys(active).length === 1 ? {} : { [key]: variantId };
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
