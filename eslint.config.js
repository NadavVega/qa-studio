import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/.next/**", "**/dist/**", "**/drizzle/**", "**/next-env.d.ts"] },
  ...tseslint.configs.recommended,
);
