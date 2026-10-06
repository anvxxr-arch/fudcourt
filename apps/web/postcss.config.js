module.exports = {
  plugins: {
    // postcss-import MUST run before tailwindcss: Tailwind expands `@tailwind` into real
    // rules, and an `@import` left after them is invalid CSS that the bundler rejects.
    // Inlining first also means the design-system stylesheets and the fontsource faces
    // arrive as ordinary rules, so a package specifier resolves once, here.
    'postcss-import': {},
    tailwindcss: {},
    autoprefixer: {},
  },
};
