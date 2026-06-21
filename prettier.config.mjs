/**
 * Prettier configuration.
 *
 * @see https://prettier.io/docs/options
 * @type {import('prettier').Config}
 */
const config = {
  tabWidth: 2,
  useTabs: false,

  // Evita ambigüedades de ASI en código que se ejecuta directamente.
  semi: true,

  // Simples reducen escapes cuando el contenido ya usa dobles.
  singleQuote: true,

  // 'all' minimiza diffs al agregar/eliminar propiedades en cualquier posición.
  trailingComma: 'all',

  // 120 deja margen para tipos largos sin cortes prematuros.
  printWidth: 120,

  // Coincide con `.editorconfig` y evita diffs por plataforma.
  endOfLine: 'lf',

  // Opciones explícitas — coinciden con defaults de Prettier.
  // Ser explícito documenta la decisión y evita sorpresas si Prettier cambia defaults.
  bracketSpacing: true,
  arrowParens: 'always',
  quoteProps: 'as-needed',
  htmlWhitespaceSensitivity: 'css',
  embeddedLanguageFormatting: 'auto',

  overrides: [
    {
      // Markdown: wrapping automático para legibilidad en diff.
      files: ['*.md', '*.mdx', '*.markdown'],
      options: {
        proseWrap: 'always',
        printWidth: 100,
      },
    },
    {
      // JSON/YAML: ancho amplio evita cortes innecesarios en archivos de configuración.
      files: ['*.json', '*.jsonc', '*.json5', '*.yml', '*.yaml'],
      options: {
        tabWidth: 2,
        printWidth: 120,
      },
    },
  ],

  // Plugins — descomentar según stack del proyecto.
  // plugins: [
  //   'prettier-plugin-tailwindcss',       // Ordena clases de Tailwind.
  //   'prettier-plugin-organize-imports',  // Ordena imports automáticamente.
  //   'prettier-plugin-pkg',               // Ordena package.json.
  // ],
};

export default config;
