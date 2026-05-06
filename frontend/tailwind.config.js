/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
      colors: {
        p0: { bg: '#fee2e2', text: '#991b1b', border: '#fca5a5', row: 'rgba(254,226,226,0.15)' },
        p1: { bg: '#fef3c7', text: '#92400e', border: '#fcd34d', row: 'rgba(254,243,199,0.15)' },
        p2: { bg: '#f3f4f6', text: '#374151', border: '#d1d5db', row: 'transparent' },
      }
    },
  },
  plugins: [],
}
