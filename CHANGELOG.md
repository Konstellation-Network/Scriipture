# Changelog

All notable changes to Scriipture follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Solidity parity: the constructs a Solidity developer reaches for now have a TypeScript spelling.** Each is covered by `tests/solidity-parity.test.ts` (70 per-feature cases, each compiled with solc), and `tests/contracts/Parity.ts` combines them in one build that type-checks against `types/index.d.ts` and is run on the EVM by forge when it is installed. The full mapping is in docs/details.md, "Solidity side by side".
  - **Interfaces and external calls.** A file-level `interface` of methods is a Solidity `interface` in its own `<Name>.sol`, emitted when the build uses it. `at<IERC20>(t).transfer(to, v)` → `IERC20(t).transfer(to, v)`, typed by the interface. `implements IFoo` → `is IFoo`. `/** @view */` (or `@pure` / `@payable`) on a method sets its mutability. Any other contract or interface a contract names (`new Child(…)`, a parameter type) is imported from `./<Name>.sol`.
  - **Inheritance.** `abstract class` → `abstract contract`; `abstract f(): T;` → a bodiless `virtual` function. `virtual` and `override` (with `override(A, B)` when several paths define the function) are inferred across the build; TS `override` and `@virtual` force them for bases outside it.
  - **Special functions and modifiers.** `receive()` → `receive() external payable`; `fallback()` → `fallback() external`. `@modifier name(…)` declares a modifier (with `_;` appended unless written), and `@name` / `@name(args)` on a function applies it; `@name(param("id"))` passes the function's own `id` parameter.
  - **Tuples.** A `[bigint, boolean]` return type → `returns (uint256, bool)`, `return [a, b]` → `return (a, b);`, `const [x, ok] = this.f()` typed from `f`, and `[a, b] = [b, a]`.
  - **Control flow and errors.** `do … while`; `try { const r = at<I>(t).f(); … } catch (e) { … }` → `try I(t).f() returns (T r) { … } catch (bytes memory e) { … }`; `unchecked(() => { … })` → `unchecked { … }`; `throw new Error("x")` → `revert("x")`; `throw this.TooLow(a)` / `throw new TooLow(a)` → `revert TooLow(a);`; `revert(this.E(…))` and `emit(this.Ev(…))`, the spellings TypeScript itself accepts.
  - **Values.** `x as Uint8` emits `uint8(x)` when `x` has a different known type; `BigInt(enumValue)` → `uint256(e)`; `type<Uint64>().max`; `1n * ether`, `7n * days`; `"0xa9059cbb" as Bytes4` → `0xa9059cbb`; `new Array<T>(n)` → `new T[](n)`; `FixedArray<T, N>` → `T[N]`; `to.call({ value: v }, data)` → `to.call{value: v}(data)`; `abi.decode<[Address, bigint]>(data)`.
  - **Typings.** `types/index.d.ts` declares everything above plus `tx`, `msg.sig`, `block.basefee` / `prevrandao` / `gaslimit`, `address(…)`, `payable(a)`, address members (`balance`, `code`, `call`, `transfer`, …), `gasleft`, `blockhash`, `assert`, `addmod`, `mulmod`, `ripemd160` and `abi.encodeWithSignature`, so contracts using them type-check without local `declare function` shims.
- `examples/crowdfund`: a complete sample (structs, an enum, five events, custom errors, a parameterised modifier, `receive`, tuple returns, checked payouts) that the test suite type-checks, compiles and, with forge installed, runs through launch → pledge → claim / refund.
- New validator rule `unknown-decorator` (27 rules). Plugins claim their own decorators with `ScriipturePlugin.decorators`.
- `inferType` knows Solidity's builtins (`keccak256` → `bytes32`, `abi.encode` → `bytes`, …), comparison and arithmetic operators, `msg` / `block` / `tx` members, address members, calls into the build's other contracts and interfaces, and `new`. An unannotated local takes that type instead of falling back to `uint256`.
- IR: `IRType` gains `tuple` and a fixed array `length`; `IRExpression` gains `tuple`, call `options` / `typeArgs` / `cast`, and a `new` element `type`; `IRStatement` gains `try` and `while.doWhile`; `IRFunction` gains `special`, `isAbstract` and `isOverride`; `IRContract` gains `isAbstract` and `interfaces`; `IRProgram` gains `interfaces`. `emitProgram` returns interface files after the contracts, marked `kind: "interface"`.
- **Structs.** A file-level `interface Foo { … }` or `type Foo = { … }` next to the contract class becomes `struct Foo { … }` inside every contract in that file. Object literals lower to `Foo({a: x, b: y})`, taking the struct name from the slot they flow into (typed local, return value, state var initializer, `Map.set` / `push` on a state var, own-method argument) or from an explicit `{ … } as Foo`. Struct locals bound to storage (`const p = this.items.get(k)`) are emitted as `Foo storage p`, so writes through them reach storage. Struct params and returns get `memory`. A declaration with no struct fields — an interface of methods, a type for a TypeScript consumer — is simply not a struct.
- **Enums.** A file-level `enum Status { A, B }` becomes `enum Status { A, B }` inside the contract; `Status.A` emits unchanged. Member initializers are a parse diagnostic (Solidity numbers members from 0).
- **Fixed-width integers and bytes.** `Uint8` … `Uint256`, `Int8` … `Int256` and `Bytes1` … `Bytes31` are exported from `scriipture` (as branded `bigint` / `string`) and map to the matching Solidity primitive. `Bytes` now maps to `bytes` and `Bytes32` to `bytes32` as primitives. Invalid widths (`Uint7`) are a parse diagnostic.
- **Tuple destructuring.** `const [ok, data] = to.call("")` emits `(bool ok, bytes memory data) = to.call("");`, which is the pattern the `no-unchecked-low-level-call` rule recommends and previously could not be written. Omitted slots become empty components; other shapes take a tuple annotation (`const [a, b]: [bigint, boolean] = …`).
- **Gate 8 gains a proof stage.** Alongside the forge invariant test (random call sequences: evidence), `verify` emits an SMTChecker harness that inherits the contract and asserts every `@invariant`, and asks solc's CHC engine to prove each one over all reachable states. The attestation carries an `invariant-proof` result per contract with proven / unproven / violated invariants. The docs no longer describe fuzzing as symbolic execution.
- **`secure-deploy` records the deployment on the attestation.** After the transaction is mined the bundle gains a `deployment` record (`network`, `address`, `txHash`, `from`, `deployedAt`, and the artifact and on-chain bytecode hashes) plus top-level `network` / `address`, and the new fingerprint is printed. `secure-deploy` also accepts `--skip`, `--fuzz-runs`, `--mythril-timeout` and `--deep`.
- **Gate results record the `engine`** that produced them (e.g. `native-solc 0.8.37+commit.f401782d`), because two solc builds of the same version differ in whether the SMTChecker can run at all.
- **`scriipture doctor` tests the SMTChecker directly**, by running a real model check through the resolved solc rather than reading its version number.
- New validator rules: `require-checked-address` (an `Address` reaching `.transfer` / `.send` / `.call` / `.delegatecall` / `.staticcall` or `pullPayment()` without `validate()`), `nullish-fallback`, `destructure-shape` and `storage-alias` (a struct or array bound to a ternary with one storage branch and one memory branch, which no data location fits).
- `@external`, `@internal`, `@public` and `@private` are exported from `scriipture`. The mapper already honoured them; the type declarations never offered them, so no one could write one.
- `defineConfig()` is exported for typed `scriipture.config.mjs` files; the example config and docs use it.
- Shared type inference (`src/mapper/infer.ts`) used by both the emitter and the validator: state variables, parameters, typed locals, indexing, `Map.get`, struct fields, the `msg` / `block` globals and literals.
- `CompileResult.modelChecker` reports whether the SMTChecker ran, with which engine, and why not. `nativeSolc()` and `probeModelChecker()` are exported.
- IR: `IRType` gains `struct` and `enum` kinds and the full primitive name range; `IRContract` gains `structs` and `enums`; `IRExpression` gains `object`; `IRStatement` gains `destructure`. Source maps include struct and enum declarations.
- CI's security job runs `verify --skip fuzz,fuzz-run` so the SMTChecker gate and the invariant proofs execute rather than being skipped wholesale.

### Changed
- **`pack-slots` is now advisory.** It used to reorder `stateVars` in place — moving every small variable ahead of mappings, arrays and `uint256`s — which silently rewrote the storage layout of the emitted contract. It now reports the slot saving as a hint (`applied: false`) and leaves the declaration order alone. Pass `--reorder-storage` to `build` / `verify` to apply it. Library users: `optimizeProgram(program, { reorderStorage: true })`.
- **`pack-slots` counts slots the way solc does.** The baseline is solc's own adjacent packing of the declared order (it never assumed one slot per variable), `constant` / `immutable` variables no longer count as slots, `string` / `bytes` are treated as full-slot dynamic types, and `Address` / `CheckedAddress` aliases are sized correctly. The pass runs after `immutable` and `constant` so those markings are visible to it. Previously the reported savings were usually fictional while the reordering was real.
- **Attestation gate results carry an explicit `status`** (`passed` | `failed` | `skipped` | `not-applicable`) and `schemaVersion` is bumped to `2`. `passed` is `true` only when the gate actually ran clean; a skipped gate used to be written as `passed: true, detail: "skipped"`, which made "clean" indistinguishable from "never ran". Skipped gates record the operator's justification when one is given; Mythril without `--deep` is recorded as `skipped` with `optIn: true`.
- **`secure-deploy` refuses to deploy when a gate was skipped** unless `--allow-skipped-gates "<justification>"` is passed, matching the `@unsafe("…")` / `@allow*("…")` pattern.
- **`scriipture build` runs the validator** and writes nothing when it reports an error, because some constructs can only be emitted by guessing. `--no-validate` opts out.
- npm keywords list only chains that ship (`base`, `base-sepolia`, `sepolia`); `optimism` and the misspelt `arbitrary` are gone.

### Fixed
- **An unknown decorator no longer vanishes.** `@onlyAdmin` with no matching modifier emitted the function with no access check, and `@private_` on a state variable emitted it `public`. The first is now an `unknown-decorator` error; the second is honoured.
- **`x **= y` compiled to `x **= y`**, which Solidity does not have; it is `x = x ** y`.
- **`throw new Error("reason")` emitted a bare `revert()`**, dropping the reason.
- **`do … while` was rejected as having no Solidity equivalent.** Solidity has it.
- **The `constant` pass froze a state variable that was only ever `++`'d, `delete`d, pushed to or written in a `for` update**: it only counted `this.x = …` statements. It and `immutable` now see every write. Neither freezes a variable a derived contract in the build writes, and `immutable` is no longer applied to `string` / `bytes`, which Solidity rejects.
- **Enums and structs were declared again in every derived contract in the file**, so any contract inheriting a same-file base failed with "Identifier already declared". They are declared once, in the base.
- **`undeclared-event` / `undeclared-error` fired for events and errors declared in a base contract**, and `custom-errors` declared a derived contract's synthesized error again when its base already had it.
- **JSDoc tags broke the build.** Doc comments become NatSpec, and solc rejects tags it does not know: `@returns`, `@throws`, `@example`. `@returns` is now `@return`, and other tags become `@custom:` tags.
- **`Indexed<T>` could not be passed a value.** It was typed `T & { __indexed: unique symbol }`, so emitting an event with an indexed parameter did not type-check without a cast. It is now `T`.
- `abi.encodeWithSelector` takes a `Bytes4` selector, as in Solidity, not a `Bytes32`.
- `audit-pack` copies the build's other `.sol` files next to each contract's, so Slither can resolve a base or interface import.
- `src/optimizer/passes.ts` carried its own copy of the IR walkers that skipped `unchecked` bodies and `for` initializers; the passes now share `walk.ts`.

**Attestation integrity**
- **A file Slither or Mythril could not analyse was recorded as a clean file.** Both loops swallowed an unparseable result with `continue`, so a crashed analyser produced "0 findings" and the gate passed. On a machine with no native `solc`, Slither exits non-zero with no output for every file, which means gate 5 has been passing vacuously there. Both now collect per-file failures, and `verify` records those contracts as `skipped` with the reason instead of `passed`; `audit --strict` fails on a partial analysis too.
- **A deployment stamp could name an address whose code was never checked.** `verify` hashes the bytecode it compiles in memory, but `deployCommand` read `out/artifacts/<name>.json` from disk — a file only `scriipture compile` writes — and the stamp recorded whatever address came back. A stale artifact was enough to make the bundle assert that audited source lives at an address holding a different contract. Gate 2 now writes the artifacts it verified and `secure-deploy` deploys from there; `secure-deploy` hashes the artifact it is about to send and refuses before the transaction unless that hash equals `hashes.deployedBytecode` (so a stale or substituted `--artifacts` directory is rejected, not deployed and then reported); `stampDeployment` repeats the check and throws `DeploymentBytecodeMismatch`; and `eth_getCode` at the address is recorded alongside it so the bundle is self-checking.
- **An empty `eth_getCode` answer was hashed as if it were the contract.** A load-balanced RPC endpoint that lags the receipt returns `0x`, which was recorded on the attestation as the on-chain bytecode with `onchainMatchesArtifact: false` — the message that is meant for immutables. `0x` is treated as "could not read" now.
- **Gate 8 could test a stale copy of the contract.** The invariant-test stage wrote `out/forge/src/<C>.sol` only if it did not exist, gate 7 (which refreshes it) is skipped under `--skip fuzz`, and `out/forge` persists between runs — so after an edit, `verify --skip fuzz` compiled the new invariant test against the previous run's Solidity. The file is written every time.
- **A Mythril run that reported an error inside its JSON was recorded as `passed, 0 finding(s)`.** Mythril prints its fatal errors (solc mismatch, compile failure, unreadable file) as valid JSON — `meta.logs` with `level: "error"` under `-o jsonv2`, `success: false` under `-o json` — and exits 0, so the unparseable-output check above did not catch it. Both shapes are now a per-file failure, like Slither's `success: false`.
- **The auto-ERC20 invariant could earn `invariant-proof: passed` on its own.** `totalSupply() >= 0` is a tautology the solver always proves, so an ERC20-shaped contract whose declared `@invariant`s all went unproved still recorded "1/N proven". When a contract declares invariants, only those count toward `passed`.
- **The attestation was never stamped if Etherscan verification failed.** `verifySourceCommand` calls `process.exit(1)` in three places and ran before `deployCommand` returned, so on a real network a verification failure left a deployed contract with no record of it. `secure-deploy` now stamps first and submits source afterwards.
- **Gate 3 could attest `passed` on a run where the solver never executed, and on one where it found a violation.** Three separate causes:
  - **Findings were never captured.** The filter accepted only diagnostics whose `errorCode` starts with `64`; CHC and BMC emit around fifty codes and none of them does (assertion violation 6328, overflow 4984, underflow 3944, division by zero 4281). Findings are now recognised by the `CHC:` / `BMC:` message prefix every SMTChecker diagnostic carries.
  - **The verdict was read from solc's severity.** The SMTChecker reports everything through `warning()` and `info()` and never `error()`, so a real counterexample was filed as a warning and the gate could not fail. The verdict now comes from the message: `… happens here` is a counterexample and fails the gate, `… might happen here` is unproved. A violated `@invariant` is therefore no longer attested as proven.
  - **What blocks is now explicit.** A proven **assertion** violation fails gate 3, which covers the `assert` a generated `@invariant` harness emits. A proven **arithmetic** issue (overflow, underflow, division by zero, empty pop) is reported with its `kind` but does not fail, because under Solidity 0.8 those revert rather than corrupt state and `showUnproved` makes them common. Both are recorded in the attestation so an auditor can apply a stricter policy.
  - **A solc with no Horn solver was recorded as a clean run.** The official release binaries are built without Z3 and emit `7649 CHC analysis was not possible since no Horn solver was found and enabled` and `8158 Solver z3 was selected for SMTChecker but it is not available`, neither of which the old check matched. Those, and codes 7710 / 4591 / 1180, are now treated as "did not run".
- **Gate 3 never actually ran at all** before that: the model-checker settings passed `contracts: { "<file>": [] }`, which solc rejects with "Source contracts must be a non-empty array", and the gate only looked at SMT findings rather than compile errors. Model checking now runs through a native `solc` with imports inlined, and is recorded as **skipped** with a reason when no solver can run.
- **Every spawn now passes `env: process.env` explicitly.** Node reads `process.env` at call time, but Bun 1.3.x snapshots it at startup, so a PATH set after the process began — by a wrapper script, or by a test — was invisible and the tool was reported missing. This made `nativeSolc()`, the Slither and Mythril runners and `scriipture doctor` behave differently across runtimes.
- **A native solc that crashed was recorded as a clean run.** `spawnSync`'s `status`, `error` and `signal` were ignored, and empty stdout parsed as `{}`. A non-zero exit, a signal, a failed spawn and unparseable output are each recorded as `ran: false` with the reason.
- **A proof attempt that settled nothing was recorded as `passed`.** `0/N proven` is now `skipped`: a reader takes `passed` for *proved*.
- Gate 8 recorded `passed: true` for every contract before forge ran, so a violated invariant blocked the deploy while the attestation still said the gate passed. The result now reflects the forge outcome, and `--skip fuzz-run` records the gate as skipped.
- Gates 7 and 8 no longer announce "an invariant was violated" when forge could not run at all (forge-std clone failed, compile error); a half-cloned forge-std is cleaned up before retrying.
- `verify` and `audit` dropped parse diagnostics, so a construct that could not be represented surfaced only as a confusing solc error at gate 2. Both report them as gate 1 errors now.
- Gate 1 counted diagnostics without a source location against no contract while still failing the gate; they count against every contract now.
- `VerifyResult.gates` was always empty; it now carries every per-contract gate result as written to the attestation.
- `scriipture audit --strict` exits non-zero when Slither did not run, instead of printing a note and passing.
- Docs claimed the attestation was "signed"; nothing signs it.

**Constructs that were silently dropped**
- **A getter or setter was deleted without a word, and the optimizer then froze the state variable.** `get current()` / `set current(v)` matched none of the member kinds the parser handles, so they vanished; with the setter gone nothing assigned `total`, the `constant` pass concluded it was never written, and the contract was emitted with `uint256 public constant total = 0` — permanently unwritable. Build, validate and solc all reported clean. Accessors are a parse diagnostic now, naming the method form to use instead.
- **TypeScript's own visibility keywords were ignored, so `private` members were published.** `private helper()` was emitted `public` and became part of the external ABI, and `private secret` became a `public constant`. `private` now maps to Solidity `private` and `protected` to `internal`, for both fields and methods, through a synthetic decorator so the fuzz generator and the calldata pass see it the same way they see `@private_`. An explicit decorator still wins.
- **Optional, default and rest parameters changed a function's interface silently.** `b?: bigint` became required, `a: bigint = 5n` lost its default, and `...vals: bigint[]` became a single array argument. Each is a parse diagnostic now, as is a TypeScript parameter property.
- **`switch`, `do … while` and `try` / `catch` were emitted as their TypeScript text**, `1n` literals and un-rewritten `this.` included, so solc reported a parse error against generated Solidity the developer never wrote. Every statement the parser cannot lower is a diagnostic at its own source line. `break` and `continue`, which happened to survive as passthrough text, are first-class statements now rather than an accident.
- **A `static` member was emitted as contract state.** It is a diagnostic.

**Emitted Solidity**
- **`calldata-params` never produced `calldata`.** The pass marked parameters `calldata` and reported the saving as applied, but the type mapper emitted `memory` for every data location, so no contract ever contained the word. Reference types now carry the location they were given.
- **`calldata` was then applied to functions that are called internally, which could not compile.** A helper such as `len(s: string)` became `function len(string calldata s)` and every internal call site failed with "Invalid implicit conversion". The pass skips `@internal` / `@private` functions and any function called from inside the contract.
- **`delete p[i]` and `p[i].push(x)` were not seen as writes through a parameter**, so both produced a `calldata` parameter solc rejects as read-only. `delete` is parsed as an operator now rather than falling through as raw text, and `push` / `pop` / `delete` are matched through indexing and member access.
- **`a ?? b` silently dropped `b`.** `const bal = this.x.get(k) ?? 7n` emitted `bal = x[k]`. A fallback that is the type's default (`0n`, `false`, `""`, `address(0)`) is genuinely redundant in Solidity and still lowers to `a`; any other fallback lowers to an explicit default-value test when the type of `a` can be inferred, and is a `nullish-fallback` error when it cannot.
- **`calldata` on a parameter that a `??` or `?:` pairs with a storage value did not compile.** `this.names.get(who) ?? fb` lowers to a ternary, and solc unifies `string memory` with a storage pointer but not `string calldata` ("True expression's type string calldata does not match false expression's type string storage pointer"). The pass keeps `memory` on a reference-typed parameter that is a branch against a storage path; a value-typed element or a literal sibling still gets `calldata`.
- **`a ?? b` with a call or an update on the left ran it twice.** The lowering reads `a` twice, so `this.queue.get(this.pop()) ?? 1n` popped twice. A left side containing a call (other than a mapping read or a type conversion), an assignment or `++` / `--` / `delete` is a `nullish-fallback` error now, with the fix of binding it to a typed local first.
- **A struct reached through a nested storage path was copied to memory, so writes through it were lost.** `const m = this.proposals.get(id).meta; m.votes = m.votes + 1n` emitted `Meta memory m = …`, which compiles and changes nothing on chain. Storage paths are now followed through any chain of `[k]`, `.get(k)` and `.field`, and through a local that is itself a storage pointer (`const p = this.items[i]; const m = p.meta`). Array and mapping locals bound to storage are pointers too (`uint256[] storage tags = proposals[id].tags`), so `push` reaches storage instead of failing to compile against a memory copy.
- **An unannotated local was typed by the emitter but not by the validator.** `const b = this.balances.get(who); return b ?? 7n` emitted `uint256 b = …` and then failed gate 1 with "the left side's type is unknown", and `s.length` on an untyped string local emitted `s.length` rather than `bytes(s).length`. Both build the type environment from one function now, which infers an unannotated `let` from its initializer.
- **A same-named local in a sibling block decided whether the other one aliased storage.** The emitter and the validator resolved every local against one flat, function-wide map, so `const p = this.proposals.get(id)` in one branch of an `if` and `const p = other` in the else made the first branch's `Meta m = p.meta` a memory copy (writes lost, compiles clean) or, in the other order, a storage pointer to a memory struct (compile error). Locals are scoped per block now, by the same `walkScoped` for the validator and block by block in the emitter; a `for` initializer is scoped to its loop.
- **A struct chosen by a ternary of two storage paths was copied to memory.** `const p = useA ? this.proposals.get(1n) : this.proposals.get(2n); p.votes += 1n` emitted `Proposal memory p`, which compiles and drops the write; before the shared inference it was a compile error. A ternary of two storage paths is a storage pointer now. A ternary that mixes a storage branch with a memory one has no faithful binding and is left untyped, so it fails to compile rather than silently copying.
- **`calldata` on a parameter passed to an own function that writes to it changed what the caller saw.** `bump(values)` writing `values[0]` and `bumpAndRead(values) { this.bump(values); return values[0]; }` gave `bumpAndRead` a `calldata` parameter, and a calldata argument is copied into a memory parameter — the caller no longer saw the increment that TypeScript, and a `memory` parameter, deliver. A parameter that flows into an own function which writes to the matching parameter keeps `memory`, through any number of hops.
- **Expressions in a `for` initializer were invisible to every pass.** `walkStatements` never visited `for.init`, so an own function called there still received `calldata` and solc rejected the call site; the mutation, storage-branch and internal-call scans were blind to it in the same way. The initializer is walked as a statement of its own now.
- **A write through a local alias of a parameter was not seen as a write to the parameter.** `const v = values; v[0] = v[0] + 1n; return values[0]` gave `values` `calldata`, so `v` became a memory copy and the caller got the original value back, where TypeScript and a `memory` parameter return the incremented one. A local initialised from a reference-typed parameter, or from an element or field of one, now counts as that parameter for both direct writes and flows into a helper that writes.
- **`?? fallback` on a `CheckedAddress` was refused.** `emptinessTest` did not resolve custom aliases, so `this.owners.get(id) ?? msg.sender` on a `Map<bigint, CheckedAddress>` — and `msg.sender` itself is a `CheckedAddress` — was a `nullish-fallback` error and `build` refused it, although `$ == address(0)` lowers it faithfully. Aliases are tested as the primitive they are emitted as. The fix hint on the genuinely untestable case no longer suggests `?? 0n`, which is wrong for anything but a number.
- **A struct bound to a ternary mixing storage and memory was emitted as `uint256` with no diagnostic.** The emitter had been leaving it untyped on purpose, but untyped meant a `uint256` guess and a later solc error unrelated to the cause. The new `storage-alias` rule reports it as an error, so `build` refuses instead.
- **A struct field whose type was declared later in the file resolved to an opaque `custom` type.** The declaration pre-pass parsed each struct's field types as it registered it, so `interface Proposal { meta: Meta; status: Status }` ahead of `interface Meta` / `enum Status` did not see them as a struct and an enum: the nested literal was reported as "object literal has no struct type" and emitted as `meta: ({title: title})`, the fuzz generator could not see the enum inside the struct, and `pack-slots` sized it at 256 bits. Names are now registered first and fields parsed second.
- **An untyped local holding a struct was emitted as `uint256`.** `const p = { … } as Proposal;` and `const p = this.draft(id);` fell through to the `let` emitter's default and produced `uint256 p = Proposal({…})`, which solc rejects. Both now infer `Proposal memory`. A nested literal under a cast literal in such a local was also left untyped, since the resolver only recursed from a typed slot; it recurses from the cast now.
- **An enum reached through an array parameter was fuzzed unbounded.** `setAll(ss: Status[])` produced a harness taking `Registry.Status[] memory`, which the ABI decoder rejects on an out-of-range element before the body runs — the same false gate 7 failure the struct-field rule avoids. Such methods are skipped too.
- **Expressions the parser could not lower were emitted as TypeScript text**, the same gap that statements had: `[1n, 2n, 3n]`, `typeof`, `>>>`, `instanceof`, `undefined`, `null`, a spread, an arrow function. Each is a diagnostic now. An *empty* array literal stays silent, because that is how an array state variable is initialised and the emitter drops that initializer.
- **`s += x` on a `string` or `bytes` emitted `s += x`**, which Solidity has no more than it has `+`. It lowers to `s = string.concat(s, x)`.
- **A local holding a struct value was typed `uint256`.** `const p = { … } as Proposal` and `const p = this.draft(id)` emitted `uint256 p = Proposal({…})`. `inferType` now types an object literal that names its struct, and a call to one of the contract's own functions by that function's return type.
- **The documented rule count had drifted from the code**, reading 18 in three places and 19 in two while the validator emitted a different number again. `RULE_IDS` is now the one list of every identifier the validator can emit, a test asserts it matches the source, and the docs quote its length (26).
- **A base contract defined in the same build emitted uncompilable Solidity.** `class Child extends Base` wrote two files and never imported the first from the second, so solc failed with "Identifier not found"; `extends` worked only for the bundled OpenZeppelin bases. A base that is another contract in the build is imported as `./<Name>.sol` now, and a base that is neither bundled nor present is an `unknown-base-contract` error rather than a solc failure.
- **String equality and concatenation emitted operators Solidity does not have.** `a === b` became `a == b` and `a + b` stayed `a + b`, neither of which compiles. They lower to `keccak256(bytes(a)) == keccak256(bytes(b))` and `string.concat(a, b)` now (`keccak256(a)` and `bytes.concat` for `bytes`), when the type is known to be dynamic.
- **Two functions sharing a name shared one mutation analysis.** `calldata-params` keyed its results by function name, so an overload that writes to its parameter made every same-named overload keep `memory`, and the reverse could hand `calldata` to one that writes. Results are keyed by the function itself, and a call to an overloaded name marks the argument if any candidate writes to that position.
- **`@private_` and `@public_` were silently ignored.** `public` and `private` are reserved words in TypeScript, so those are the only spellings the package can export, but the decorator table only knew the bare names: a `@private_` helper was emitted `public` and externally callable, with no diagnostic. The parser maps them to `private` / `public`.
- **`scriipture build` emitted programs it had to guess at**, because it never ran the validator — the path most users run first wrote a plausible-looking contract that was not the program they wrote. This also caught a real case in the bundled bridge example (`signers[0] ?? msg.sender` on a parameter array).
- **The fuzz harness used unqualified struct and enum names**, so every contract using the new types failed gate 7 with "Identifier not found or not unique" — `Item` and `Status` are members of the contract and must be written `Registry.Item` inside the harness. Enum parameters are taken as a bounded `uint8`, because the ABI decoder rejects an out-of-range enum before any `vm.assume` in the body could run, and a method taking a struct that contains an enum is skipped for the same reason.
- **A harness with no test function is no longer generated**, so a contract whose methods all take zero arguments (`examples/counter`) records gate 7 as `not-applicable` instead of failing on `forge: No tests match FuzzAuto`.
- **Every file-level `interface` became a struct**, so one with methods emitted `struct IFoo {}` and solc rejected it.
- Default values, rest elements and nested patterns in a destructuring declaration were silently mangled; each is a parse diagnostic now.
- `s.length` on a string emitted `s.length`, which Solidity rejects; it emits `bytes(s).length` now.
- The emitter and the validator built their type environments separately, so a destructured local used in a `?? fallback` was typed by one and not the other and a valid program failed gate 1.

**Examples**
- `examples/bridge/ChainLockBridge.ts` declared `@invariant invariantValidatorWeightSane()` asserting `totalWeight <= 1_000_000`, but `addValidator` only capped each validator at 1000 and never the total, so 1001 validators broke it. `addValidator` now enforces the bound the invariant asserts. Found by the new proof stage.

**Other**
- The SMTChecker harness was written into `out/sol`, where `compile out/sol` globs it into a deployable artifact and Slither audits it as a contract. It goes to `out/smt/` now.
- `verify`'s generated `foundry.toml` resolved OpenZeppelin relative to the current directory; it uses the same resolver as the compiler now, so forge runs work when scriipture is an installed dependency.
- Gate 8 creates the forge `src/` and `test/` directories itself, so `--skip fuzz` no longer makes invariant-test emission fail on a missing directory.
- `MINTLIFY_BRIEF.md` said custom networks in the config file do not work. `resolveChain` builds a viem chain from any `networks` entry with an `rpcUrl` and `chainId`, so the brief now says to write that guide.

## [0.1.0] - 2026-08-15

First release under the **Scriipture** name. Version numbering restarts at `0.1.0`; the `0.2.x` entries below are the history of this same codebase under its former name, `solidscript`.

### Changed
- **Renamed the project from SolidScript to Scriipture.** This is a breaking change for every consumer.
  - The npm package is now **`scriipture`** (the old `solidscript` package is no longer updated). Install with `npm install scriipture`.
  - Imports change from `solidscript` / `solidscript/standards` to `scriipture` / `scriipture/standards`.
  - The CLI binary is now `scriipture` (e.g. `npx scriipture doctor`).
  - The project config file is now `scriipture.config.ts` / `scriipture.config.mjs` (was `solidscript.config.*`). Rename yours; the old filename is not read.
  - User-level state moved from `~/.solidscript/` to `~/.scriipture/`, covering `config.json` and `wallets/`. **Existing hot wallets and config are not migrated automatically** — move the directory yourself with `mv ~/.solidscript ~/.scriipture` before running the new CLI.
  - Attestation bundles now record the toolchain component as `scriipture` rather than `solidscript`, so attestations produced before and after this release differ in that field.

## [0.2.4] - 2026-05-13

### Fixed
- **Release workflow's "verify publish landed" step now retries with backoff** (up to ~90s, 18 attempts × 5s) instead of querying npm once after a fixed 5-second sleep. The npm CDN can take 30–60s to propagate a freshly-published version; v0.2.3's release workflow timed out at the verify step because of this lag, even though the publish itself succeeded. v0.2.4 is the first release that runs through Plan B end-to-end without manual intervention.

## [0.2.3] - 2026-05-13

### Fixed
- `scriipture --version` now reads from `package.json` at runtime instead of returning the hardcoded `0.0.1`. Resolves the version-reporting bug introduced in earlier releases.
- **Release workflow hardened against trailing `npm publish` 403s.** `npm publish --provenance` occasionally returns a non-zero exit code after successfully writing to the registry and pushing the provenance attestation to sigstore's transparency log (race between the registry write and the CLI's internal verify check). The release workflow now treats the publish step's exit code as advisory and uses a follow-up `npm view scriipture@$VERSION version` query to determine the real outcome. If the version is on the registry, the workflow proceeds to create the GitHub Release. If it's genuinely missing, the workflow hard-fails. This was discovered while shipping v0.2.2 — the package published successfully but the workflow reported failure, requiring manual `gh release create` to finish the release. v0.2.3 is the first release shipped through the fully automated path.

## [0.2.2] - 2026-05-13

### Added
- **Auto-pipx fallback** for Slither and Mythril in `scriipture doctor --fix`. Resolution order is now `PATH → Docker → pipx install`. When `pipx` is present and neither a native binary nor a Docker image is available, doctor automatically runs `pipx install slither-analyzer` / `pipx install mythril` instead of just printing the install hint.
- `scriipture doctor` (no `--fix`) now distinguishes between "Docker present" and "pipx present" in its hint text, so users see the exact path that will be tried.

### Fixed
- Removed dead `extract as tarExtract` import from `src/runtime/tool-paths.ts` that was producing a TypeScript declaration emit warning during build.

### Verified
- First release through the Plan B CI/CD workflow (GitHub Actions: tag push → `bun run build` → `npm publish --provenance --access public` → GitHub Release with tarball). 0.2.1 was the last manual publish.

## [0.2.1] - 2026-05-13

### Changed
- `scriipture.config.example.ts` renamed to `scriipture.config.example.mjs` to match what `scriipture init` writes
- `package.json` metadata filled in (author, repository URL, homepage, bugs)
- Docs updated to reflect the 9-gate pipeline (Mythril added as Gate 4 in 0.2.0; stale 8-gate references corrected throughout)

### Removed
- Dev-internal `SECURITY_SYSTEM_REPORT.md` (content folded into `docs/details.md` §8)
- Stray `contracts/TrillionToken.ts` artifact at repo root
- Working dev `scriipture.config.ts` — the `.example.mjs` is the template users copy

### Added
- `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, this `CHANGELOG.md`
- `.github/ISSUE_TEMPLATE/bug_report.yml`, `.github/ISSUE_TEMPLATE/feature_request.yml`
- `.github/PULL_REQUEST_TEMPLATE.md`, `.github/CODEOWNERS`
- `LANDING.md` — structured marketing-page content for the website

### Fixed
- `tests/fixtures/RequireToError.ts` moved to `tests/contracts/` (consolidated test-contracts under a single folder); test import updated

## [0.2.0] - 2026-05-12

### Added
- **Mythril gate** as Gate 4 of the verify pipeline (symbolic execution, opt-in via `--deep`)
- **`scriipture doctor --fix`** — auto-fetches Foundry binaries to `~/.scriipture/bin/` and pulls Slither/Mythril Docker images, making the toolchain self-contained after one command
- **Tool resolver** (`src/runtime/tool-paths.ts`) — every spawn site goes through a unified resolver with native + Docker fallback
- **OpenZeppelin v5 bundled** as a regular dependency (was peer dep in 0.1.x; now `npm install scriipture` brings it automatically)
- **Library entry point** at `src/index.ts` — programmatic API (`parseContractFiles`, `emitProgram`, `validateProgram`, `optimizeProgram`, `compileSolidity`, plus all IR types)
- **Etherscan v2 multichain verification** — one API key works for Base, Optimism, Arbitrum, Polygon, ZkSync, Ethereum, every testnet
- **Browser-wallet deploy** (`--browser` flag, default when no `--wallet`) — local HTTP bridge at `localhost:7654`, signs via MetaMask/Rabby/Coinbase Wallet
- **User-level config** at `~/.scriipture/config.json` (mode 0600) — `scriipture config set etherscan-key …` subcommand
- **GitHub Actions CI** — test matrix (node 18/20/22) + pack-smoke + security gates; release workflow on `v*` tag
- **`docs/details.md`** (14-section guide), **`docs/openapi.yaml`** (browser-deploy HTTP surface), **`docs/cli-commands.yaml`** (auto-generated CLI manifest)

### Changed
- Build pipeline switched from `tsc` to Bun's bundler — produces a tighter dist
- CLI shebang `#!/usr/bin/env bun` → `#!/usr/bin/env node` so the published package works under any Node-based runtime
- `scriipture init` now writes `scriipture.config.mjs` instead of `.ts` (Node ESM can load `.mjs` directly without a TS runtime)
- `scriipture verify` consolidated `--no-fuzz`, `--no-smt`, etc. into a single `--skip <gates>` flag
- `scriipture deploy` smart defaults: auto-`--browser` when no `--wallet` given, auto-verify when `etherscan-key` configured

### Fixed
- `attestation.ts:readScriiptureVersion()` now resolves Scriipture's own `package.json` via `import.meta.url` (was reading the user's project `package.json`)
- Custom-errors pass no longer produces double-negation (`if (!!emergencyMode)` → `if (emergencyMode)`)
- Unary operator emit wraps its operand in parens when needed (`!x >= y` → `!(x >= y)`)
- TS-only `Number(i)` / `BigInt(i)` casts stripped during parsing (don't leak into Solidity)
- `CheckedAddress` and `Bytes32` branded TS types alias to `address`/`bytes32` in generated Solidity
- `@invariant` decorator implies `view` mutability
- View-mutation rule no longer false-positives on local variable reassignment

## [0.1.0] - 2026-05-12

Initial public commit. TypeScript → Solidity transpiler with 8-gate security pipeline (gate 4 added in 0.2.0), forge bridge, examples, plugin API, attestation bundle, source maps, gasdiff, audit-pack, multi-chain deploy. See README and `docs/details.md` for the full feature surface.
