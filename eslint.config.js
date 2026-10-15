import globals from "globals";
import react from "eslint-plugin-react";

export default [
  {ignores:["dist/**","node_modules/**"]},
  {
    files:["src/**/*.{js,jsx,mjs}","scripts/**/*.mjs","vite.config.js"],
    plugins:{react},
    languageOptions:{
      ecmaVersion:"latest",sourceType:"module",
      parserOptions:{ecmaFeatures:{jsx:true}},
      globals:{...globals.browser,...globals.node},
    },
    rules:{"no-undef":"error","react/jsx-no-undef":"error","react/jsx-uses-vars":"error","no-unused-vars":["error",{args:"none",varsIgnorePattern:"^_"}]},
  },
];
