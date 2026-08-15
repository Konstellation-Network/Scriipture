import type { ScriipturePlugin } from "../src/plugin/api";

const plugin: ScriipturePlugin = {
  name: "no-future-comments",
  validatorRules: [
    {
      name: "no-todo-natspec",
      run: (contract) => {
        const out = [];
        for (const fn of contract.functions) {
          if (fn.natspec && fn.natspec.some((n) => /TODO|FIXME|XXX/.test(n))) {
            out.push({
              rule: "no-todo-natspec",
              severity: "warning" as const,
              message: `function "${fn.name}" carries a TODO/FIXME/XXX comment`,
              loc: fn.loc,
            });
          }
        }
        return out;
      },
    },
  ],
};

export default plugin;
