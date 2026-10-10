// Which loop variants are on. `active` maps lane key -> variant id. Pure: the
// UI owns the state, the engine only receives the lanes derived from it.

/**
 * Lane a variant plays on. Exclusive layers (kick, bass) have one lane, so a
 * second variant replaces the first: two kicks or two basses usually only
 * muddy. The rest stack: each variant is its own lane (hat + clap + toms at
 * once). A Ctrl+click still stacks on an exclusive layer: the extra variant
 * gets a lane of its own, keyed by its id like a stacking layer's.
 */
export const laneKey = (layer, variantId) => (layer.exclusive ? layer.id : variantId);

const inLayer = (id, layerId) => id.split(".")[0] === layerId;

/** Whether `variantId` plays on any lane of `active`. */
export const isOn = (active, variantId) => Object.values(active).includes(variantId);

/**
 * A click toggles that variant. On an exclusive layer a plain click leaves it
 * alone there (replacing every other variant of the layer), and `add` (Ctrl)
 * stacks it next to them instead.
 */
export function pressVariant(active, layer, variantId, add = false) {
  const next = { ...active };
  const own = Object.keys(active).find((k) => active[k] === variantId);
  if (own) {
    delete next[own];
    return next;
  }
  const key = laneKey(layer, variantId);
  if (layer.exclusive && add && next[key]) {
    next[variantId] = variantId;
    return next;
  }
  if (layer.exclusive && !add) {
    for (const k of Object.keys(next)) if (inLayer(next[k], layer.id)) delete next[k];
  }
  next[key] = variantId;
  return next;
}

export const BG_KICK_VARIANT = "kick.punchy";

/**
 * Lanes the engine should be playing: the active variants plus the background
 * kick, which only fills in when some other layer is on and no kick variant is
 * selected (so it never doubles a kick and never plays on its own).
 */
export function desiredLanes(active, { bgKick }) {
  const lanes = { ...active };
  if (bgKick && Object.keys(active).length > 0 && !Object.values(active).some((id) => inLayer(id, "kick"))) {
    lanes.bgKick = BG_KICK_VARIANT;
  }
  return lanes;
}
