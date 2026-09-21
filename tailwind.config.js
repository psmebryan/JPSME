/** @type {import('tailwindcss').Config} */

// The brand palette: the JPSME seal's two colours, at the seal's own chroma.
//
// This went matte once and it was a mistake. Desaturating the GLOSS was right
// — the 36px glow, the wet-looking shadows, the near-black grounds — but I took
// the saturation out of the BRAND along with it, and a student organisation's
// site rendered in 48%-saturated brass and 30%-saturated indigo reads as
// faded rather than as restrained. Matte is a surface quality. It is not a
// licence to drain the colour.
//
// So both ramps are built from the seal's own hues at close to the seal's own
// chroma, and the proof is arithmetic: ink-600 below computes to #322d8b, and
// the blue in the logo is #322d8a. The page and the mark on it are now
// literally the same colour.
//
// What stays from the matte pass is everything that was about FINISH rather
// than hue: no element sits at pure black or pure white, shadows are contact
// shadows rather than gloss drops, and there is no bloom on anything.
//
// amber is left alone — the admin panel uses it to mean "warning", and a brand
// colour and a status colour should not be the same token even when they match.
const ink = {
  950: '#131131', // deepest ground
  900: '#191740', // dark bands
  850: '#1f1c4f',
  800: '#25225d',
  700: '#2b2871',
  600: '#322d8b', // THE seal's blue
  500: '#4540a5',
};

// Text on the indigo grounds. Plain slate greys look muddy over a violet-biased
// dark; these carry a little of the ground's own hue so they sit on it.
const mist = {
  200: '#d3d2e5',
  300: '#b7b6ce', // navigation, secondary copy on the dark bands
  400: '#9a98b3',
  500: '#8685a3', // the lightest that still clears AA on the deepest ground
  600: '#605e78',
};

// The light side of the same brand, for the public pages.
//
// Two measured facts decide this whole scheme:
//
//   Gold as TEXT on a light ground is 1.6:1. That is not a near miss, it is
//   unreadable — so gold is only ever a SURFACE here, with indigo on top of it.
//   Where something gold-voiced has to be type, it is `bronze`, which is the
//   seal's gold in shadow rather than a new colour.
//
//   And a card on this page separates from it by 1.1:1, which is nothing. On
//   the dark scheme a card could be lifted by value alone; here it cannot, so
//   cards are defined by a border and a contact shadow instead.
//
// The warmth here is real but restrained: around 20% saturation. It was 35%
// once, which put a yellow ground under violet type — hues 200 degrees apart,
// near enough to complementary that the type appeared to buzz against the page.
// It was then cut to 11%, which is where "pale" came from. This is the middle.
const paper = {
  0: '#fdfcf9',   // cards
  50: '#f4f1e9',  // the page
  100: '#ebe7db', // alternating bands, insets
  200: '#dbd5c6', // hairlines
};

// Text on paper, named `pen` rather than `slate`: Tailwind already has a slate,
// and redefining it here silently repainted the admin panel's headings too.
//
// These stay close to neutral deliberately. The brand belongs in the surfaces
// and the accents; body copy that carries much chroma is what made the page
// uncomfortable to read before.
const pen = {
  900: '#221f33', // headings
  700: '#423f52', // body
  500: '#5f5c6e', // captions — the lightest that still clears AA on a band
};

const bronze = '#785d12'; // gold-voiced text, where gold itself cannot be

const gold = {
  200: '#f7e5b6',
  300: '#efd280', // gold as TEXT, on the dark grounds only
  400: '#ecb827', // THE seal's gold
  500: '#bd921f',
  600: '#9a7719',
};

module.exports = {
  content: ['./views/**/*.ejs', './public/js/**/*.js'],
  theme: {
    extend: {
      colors: { ink, mist, gold, paper, pen, bronze },

      // Typography has two voices, and both come from fonts already on the
      // reader's machine.
      //
      // There is no webfont here and it is not an oversight: style-src is
      // 'self' plus a nonce, so a <link> to fonts.googleapis.com is blocked
      // outright and the page would silently fall back anyway. Tailwind's
      // default `sans` is already a strong system stack — the hierarchy below
      // is built from scale, weight, tracking and measure rather than from a
      // typeface nobody can load.
      //
      // `tech` is the second voice: the one a drawing sheet is annotated in.
      // Eyebrows, dates, figures, seat numbers and badges are set in it, so the
      // data on this page looks like data and the prose looks like prose.
      fontFamily: {
        tech: [
          'ui-monospace', '"Cascadia Mono"', '"SF Mono"', 'Menlo',
          'Consolas', '"Liberation Mono"', 'monospace',
        ],
      },

      // One container width for the whole site. Every section reaches for this
      // rather than picking its own, which is most of what stops a page reading
      // as a stack of unrelated blocks.
      maxWidth: {
        container: '1240px',
      },
    },
  },
  plugins: [],
};
