/** @type {import('postcss-load-config').Config} */
const config = {
  plugins: {
    tailwindcss: {},
    // hover styles only where a pointer can hover (phones: no sticky hover after a tap)
    "./lib/postcss/hover-media.cjs": {},
  },
};

export default config;
