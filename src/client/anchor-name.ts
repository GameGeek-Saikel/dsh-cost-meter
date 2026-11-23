/**
 * The CSS anchor name one cost control and its portaled panel share.
 *
 * DSH 0.2.2 retired `useAnchoredPosition` and made CSS Anchor Positioning the
 * only supported way to place a panel: the trigger carries `anchor-name`, and
 * the panel resolves the same name through `position-anchor`. A style object
 * therefore travels to both elements — the panel lives in a body portal, where
 * it inherits nothing from the trigger.
 * @module @gamegeek-saikel/dsh-cost-meter/client/anchor-name
 */
import { useId, useMemo, type CSSProperties } from 'react'

/** Custom property holding this instance's anchor name. */
export const ANCHOR_VARIABLE = '--cost-meter-anchor'

/**
 * Own the anchor name of one control and its detail panel.
 * @returns an inline style declaring {@link ANCHOR_VARIABLE}; apply it to the
 *  trigger and to its portaled panel.
 */
export function useAnchorStyle(): CSSProperties {
  const id = useId()
  return useMemo(
    () => ({ [ANCHOR_VARIABLE]: `--cost-meter-chip-${id.replaceAll(':', '')}` }) as CSSProperties,
    [id],
  )
}