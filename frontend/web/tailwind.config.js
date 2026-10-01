/** @type {import('tailwindcss').Config} */
module.exports = {
  // One tree, one glob (DR-018): routes, features, platform, ui, styles and cms
  // all live under src/, so the previous `./app/**` + `./components/**` pair —
  // which had already gone stale once — cannot drift again.
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: { extend: {} },
  plugins: [],
};