// JSDoc conserva este archivo como JavaScript ejecutable y aun asi da autocompletado tipado de Prettier.
/** @type {import('prettier').Config} */
const config = {
  // LF coincide con .editorconfig y evita que Prettier introduzca diffs por sistema operativo.
  endOfLine: 'lf',

  // Los puntos y coma reducen ambiguedades de ASI en archivos de configuracion ejecutables.
  semi: true,

  // Las comillas simples siguen la guia JavaScript cargada y reducen escapes en textos con comillas dobles.
  singleQuote: true,

  // Las comas finales minimizan cambios de diff cuando se agregan nuevas propiedades u opciones.
  trailingComma: 'all',

  // Se mantiene en 2 para respetar la regla vigente de .editorconfig para JS, TS, JSON y YAML.
  tabWidth: 2,

  // 120 ofrece margen para configuraciones y tipos largos sin forzar cortes prematuros.
  printWidth: 120,

  // En Markdown, preservar el wrapping evita reescribir prosa donde los saltos tienen intencion editorial.
  proseWrap: 'preserve',
};

export default config;
