// The project's `solid-js` resolves to the SSR build (no reactivity). Test
// infrastructure imports the reactive build directly from the dist path. This
// ambient declaration reuses the canonical `solid-js` type surface so the
// reactive import stays fully typed.
declare module 'solid-js/dist/solid.js' {
  export * from 'solid-js';
}
