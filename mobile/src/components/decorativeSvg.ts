import { Platform } from 'react-native';

/**
 * Props that keep a decorative SVG drawing (one the view around it labels, or that says nothing)
 * out of screen readers. On iOS and Android that's `accessible={false}`. On the web the drawing is a
 * plain <svg> element, which screen readers already skip, and `accessible` isn't an attribute it
 * takes: React warns about it ("Received `false` for a non-boolean attribute"), so there it's left off.
 */
export const DECORATIVE_SVG: { accessible?: false } = Platform.OS === 'web' ? {} : { accessible: false };
