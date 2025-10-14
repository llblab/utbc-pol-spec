# UTBC+POL — Second-Order DAO (POLDAO) Specification

**Status:** Draft — progressive, implementation-ready.

Intended as a single-source spec for launching and operating second-order UTBC+POL DAOs (“POLDAO”), plus ecosystem-level interactions when the parachain treasury participates (Drip Vault, BLDR pattern).

---

## Executive summary

A **POLDAO** is a second-order DAO that issues a custom token (SODT) using any mint curve, yet to receive ecosystem certification it must establish immutable **Protocol-Owned Liquidity (POL)** paired with the parachain **Native** token. When the parachain treasury participates—through a one-shot purchase, a Drip Vault stream, or buyback cycles—its holdings become the durable alignment layer that replaces classic team shares. This specification encodes the minimum invariants and progressive patterns required to:

- bootstrap liquidity safely without leaking POL;
- inherit first-order security through Native proxy approvals and treasury voting multipliers;
- run BLDR-style payroll and invoice flows with minimal UX friction; and
- explore multiple growth branches (treasury-led BLDR hub, contributor meshes, open market issuance) while keeping hostile governance attacks prohibitively expensive.

The document emphasises pragmatic primitives: supermajority + timelock + veto windows for critical actions, no soulbound councils, no artificial spend caps, and optional extensions that teams can opt into at launch.

---

## Table of contents

1. Definitions & actors
2. Core invariants (musts)
3. POLDAO lifecycle (creation → mint → POL build)
4. Treasury participation modes (one-shot, Drip Vault, buyback)
5. Governance primitives (Native proxy, multipliers, voting escrow)
6. BLDR pattern — payroll & invoice flows
7. Viable development branches
8. Security model: attack vectors & defenses
9. Policy templates & recommended parameters
10. Implementation notes (Substrate pallets & hooks)
11. Deployment roadmap
12. Open variants & extensions

---

## 1. Definitions & actors

- **Native** — parachain base token (first-order asset) governed by first-order referenda.
- **DAO** — decentralized autonomous organization in the broad sense, covering any collective that coordinates through on-chain rules.
- **SODAO** — second-order DAO layered atop the ecosystem’s Native DAO. It can bootstrap or even delegate control to Native participants, yet may anchor governance to any token the community selects.
- **POLDAO** — a SODAO mandated to maintain protocol-owned liquidity paired with Native so liquidity remains locked unless governance explicitly amends the status quo.
- **UTBC** — unidirectional token bonding curve that derives new issuance from supply and formula inputs. It never burns tokens; instead, it can mint reserves in foreign assets that builders redirect flexibly (e.g., toward liquidity support).
- **POL** — protocol-owned liquidity that either keeps LP tokens in existing pools or runs as an independent AMM liquidity source. The defining property is persistence: liquidity cannot be withdrawn unilaterally, and even treasury-held LP tokens stay effectively locked until governance alters them, at reputational cost.
- **UTBC+POL** — composite primitive where the UTBC mint curve issues tokens while routing foreign reserves into POL against Native, preserving structural demand for the base asset.
- **UTBC+POL SODAO** — specialized SODAO using a configurable UTBC curve with Native reserves. It mints `SODT`, allocates a portion into POL, and governs via `SODT`, while Native-held `SODT` inside the ecosystem treasury can provide dual-factor approvals.
- **SODT** — canonical token supplied by a SODAO. It may arise from UTBC+POL issuance or from custom mint/burn logic defined by that DAO.
- **Drip Vault** — first-order treasury facility: timed vault-account abstractions that can be funded and then execute sequences of conversions or actions over time, akin to economic capacitors. A Drip Vault can dollar-cost-average trades, schedule deferred transfers, lock tokens, or act as a module for other tokenomics components. For example, the treasury may configure a Drip Vault actor to convert all allocated Native into BLDR across a month and send BLDR back to the treasury. Control over a Drip Vault can be bound to a specific DAO token or made immutable, and a Drip Vault self-destructs once its balance falls below the existential deposit.
- **vSODT** — optional voting escrow where SODT is parked (“cube”) to cast governance votes; primarily used by the treasury aggregation contract.
- **Treasury proxy account** — first-order treasury multisig or runtime account that locks SODT and exposes Native holders to proxy voting.
- **BLDR** — canonical builder token example: an ecosystem-level POLDAO used for payroll, invoicing, and ecosystem grants.

---

## 2. Core invariants (musts)

Every POLDAO claiming ecosystem certification MUST enforce these invariants on-chain:

1. **POL immutability** — LP tokens marked as POL are non-withdrawable unless a proposal completes (a) POLDAO supermajority approval, (b) a mandatory timelock, and (c) a veto window where Native proxy voters can reject it.
2. **Native floor liquidity** — launch requires depositing protocol-owned SODT/Native liquidity whose Native leg exceeds a governance-defined floor. This upfront pairing makes the POLDAO’s token generation functionally equivalent to launching an ecosystem token while guaranteeing baseline demand for Native utility.
3. **Mint-to-treasury cap** — after any mint, the new circulating user supply must satisfy
   ```
   circulating_user ≤ cap_factor × treasury_locked
   ```
   where `treasury_locked` counts SODT held in the ecosystem treasury (including Drip Vault commitments). Default `cap_factor = 0.99`. This ensures the treasury can always outvote a pure market whale.
4. **Team share optionality** — ecosystem-launched POLDAOs MAY set `team_share = 0`. If so, governance weight comes solely from treasury-held SODT boosted via Native proxy voting (see §5). Non-zero team shares require vesting ≥ 5 years and cannot bypass cap checks.
5. **Critical action gate** — POL withdrawal, bonding curve edits, or treasury drains larger than a configurable threshold require **dual approvals**: POLDAO supermajority **and** Native proxy approval during the veto window.
6. **Telemetry proof** — POL depths, treasury balances, outstanding mint obligations, and Native proxy tallies must be emitted on-chain each block so independent monitors can detect anomalies.

Everything else is configurable per DAO.

---

## 3. POLDAO lifecycle

1. **Registration** — proposer submits: mint curve parameters, share splits (`user / pol / treasury / team`), desired cap factor (≤ global max), overlay fee, governance schema (Native-only, mixed, or SODT-only), and Drip Vault preferences (if any). Automated checks ensure shares sum to 100% and cap factor respects system limits.
2. **Activation mint** — approved proposer locks at least `Native_min_deposit`. The first mint must route `pol_share` into an XYK pool (SODT/Native) and tag LP tokens as POL, and the Native contribution must clear the governance-defined liquidity floor so the launch immediately sustains ecosystem demand. Treasury-held SODT enters the treasury account directly.
3. **Native proxy wiring** — if the DAO opts for Native-governed control (typical for ecosystem-launched BLDR-like DAOs), the treasury proxy stakes the minted SODT and exposes votes through Native referenda. Otherwise, SODT holders control the DAO directly via vSODT or liquid voting.
4. **Operations** — additional mints may originate from users or the treasury. Each mint enforces the cap check and automatically increases POL. POLDAO proposals cover spending, fee tweaks, and optional buybacks.
5. **Graduation** — once the DAO maintains positive cash flow and healthy POL depth for N epochs, the treasury may lower multiplier or Drip Vault cadence via Native referendum.

---

## 4. Treasury participation modes

### 4.1 One-shot seed

Treasury swaps a lump sum of Native for SODT via bonding curve or market buy. Result: treasury holds SODT (user share) and POL deepens immediately. Useful for kickstarting BLDR or strategic ecosystem tokens.

### 4.2 Drip Vault stream (recommended)

Periodic conversion of Native into SODT with parameters:

| Parameter           | Example            | Notes                                 |
| ------------------- | ------------------ | ------------------------------------- |
| `tranche_size`      | 0.1% treasury/week | adjustable per DAO                    |
| `cap_factor_guard`  | 0.95               | Drip Vault halts if cap breached      |
| `pol_route_percent` | ≥ pol_share        | ensures POL constant growth           |
| `treasury_route`    | remainder          | enters treasury proxy with multiplier |

Drip Vault scheduling ensures long-term demand and gives users a map of upcoming liquidity.

### 4.3 Buyback / recycle

Treasury buys SODT when XYK price drops below bonding curve, then:

- re-locks into treasury proxy (boosting governance weight),
- re-sells later to fund new grants, or
- directs to other SODAOs as strategic collateral.

---

## 5. Governance primitives

### 5.1 Native proxy approval (two-factor)

For critical proposals, execution requires:

1. POLDAO supermajority vote (weight from SODT governance schema).
2. Native referendum (or delegated vNative vote) confirming the same proposal within the veto window.

If Native rejects, the proposal auto-cancels. This inherits first-order security without councils.

### 5.2 Treasury multiplier & proxy weight

- Treasury-held SODT locked in the proxy account gains a configurable multiplier `m` (default 3). The multiplier can be changed only via Native referendum + POLDAO supermajority.
- If users cannot mint more than 99% of treasury-held amount, treasury weight always dominates, ensuring veto capacity.

### 5.3 Optional vSODT escrow (“cube”)

- POLDAO may enable a simple deposit contract: SODT → vSODT (non-transferable) with a short withdrawal cooldown (24–48h). This provides soft protection against flash-mint voting. It is optional and can be disabled for Native-only governance.

### 5.4 Governance schema menu

During launch, a POLDAO picks one of three schemas:

1. **Native-only** — all proposals governed exclusively via Native proxy; SODT only carries economic rights. Preferable for ecosystem-launched POLDAOs with zero team share.
2. **Hybrid** — SODT holders vote first; Native retains veto via approval step. Default for BLDR.
3. **SODT-only** — community-driven DAOs with their own security budget; still benefit from treasury multiplier if treasury participates.

### 5.5 Fractal governance and the trilemma

- **Wide × expert × fast** — sustainable governance must remain broadly legitimate, technically competent, and operationally responsive. Traditional fixes (councils, pure delegation, quadratic voting) usually satisfy only two aspects, drifting toward centralisation or gridlock.
- **Layered control** — UTBC+POL SODAOs separate strategic and operational layers: the Native DAO sets macro allocations, holds veto authority, and wields treasury multipliers, while the SODAO executes with domain expertise and SODT-denominated skin in the game.
- **Economic coupling** — immutable POL, Native pairing, cap factors, and proxy multipliers prevent capture: operational autonomy is balanced by structural demand for Native and Native’s ultimate veto.
- **Quality without bureaucracy** — expert review happens where SODT concentrates while every critical motion still traverses Native veto windows, satisfying the governance trilemma without defaulting to shadow councils.

---

## 6. BLDR pattern — payroll & invoice flows

1. **Funding** — Treasury seeds BLDR via one-shot or Drip Vault deployment. `team_share = 0`, `treasury_share` accumulates BLDR inside the BLDR DAO.
2. **Assignments** — contributors submit invoices (hash + metadata). BLDR DAO opens a vote; BLDR circulation can remain liquid—no need for heavy escrow.
3. **Approval** — BLDR holders vote; treasury multiplier ensures alignment. If payout involves Native from treasury, Native proxy referendum confirms within veto window.
4. **Execution** — on approval, BLDR DAO disburses BLDR (or swaps to Native through XYK). Payments are on-chain with references to pull requests/tasks.
5. **Recycling** — treasury may periodically sell a portion of BLDR to replenish Native reserves, keeping long-term runway.

This pattern turns payroll into transparent, veto-able flows without team allocations.

### 6.1 Decision velocity & feedback loops

- **Throughput jump** — the Native DAO seeds BLDR once (≈28 days) whereas BLDR invoices settle in ≈3 days, increasing funded workstreams by an order of magnitude without exhausting first-order voters.
- **Loop A — POL flywheel**: treasury seeding → deeper POL → lower slippage → contributors hold longer → softer sell pressure → stronger floor → more confident issuance.
- **Loop B — Reputation compounding**: consistent delivery increases contributor reputation, boosting future voting weight and reinforcing merit-based prioritisation.
- **Loop C — Market discovery**: competing invoice streams surface true priorities; price signals replace centrally planned roadmaps while Native veto remains the guardrail against misalignment.

---

## 7. Viable development branches

| Branch                 | Description                                                                                                       | Strengths                                                          | Security hooks                                                |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------- |
| **BLDR Hub**           | Single BLDR DAO channels payroll for all builders.                                                                | Simple UX, treasury-aligned, strong veto via multiplier.           | Native-only governance or hybrid with `cap_factor = 0.99`.    |
| **Contributor Mesh**   | Each team launches its own POLDAO; BLDR DAO grants BLDR to teams, which mint their own tokens for sub-treasuries. | High experimentation, natural selection of curves and shares.      | Hybrid governance, BLDR used as reserve asset in team DAOs.   |
| **Open Market POLDAO** | Community launches SODT with custom curves; treasury participates opportunistically.                              | Diverse tokenomics, fosters ecosystem speculation with guardrails. | Cap factor & Native veto ensure no capture of base resources. |

All branches rely on the same core invariants and can coexist.

### Specialisation and fractal scaling

- **Domain SODAOs** — BLDR can stream resources into specialised operational DAOs (runtime, infrastructure, UX, documentation). Each launches its own UTBC+POL token against Native so subject experts govern focused backlogs.
- **Project SODAOs** — discrete initiatives (DEX, wallet, bridge) spin up bounded-budget SODAOs with milestone-linked issuance, containing downside while preserving upside via immutable POL floors.
- **Governance DAG** — the ecosystem forms a directed acyclic graph: resources cascade downward, telemetry and accountability flow upward, and cross-SODAO payments (service fees, revenue sharing) deepen mutual POL and utility demand.
- **Bandwidth expansion** — distributing operational choices across specialised layers pushes aggregate decision capacity from single-digit monthly referenda to hundreds of informed approvals without degrading quality.

---

## 8. Security model: attack vectors & defenses

| Vector                      | Description                                         | Mitigation                                                                                                        |
| --------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **Mint-whale capture**      | Attacker mints massive SODT to outvote treasury.    | Cap factor (≤99%), treasury multiplier, Native veto.                                                              |
| **Flash governance**        | Attacker mints, votes, and withdraws instantly.     | Optional vSODT cooldown or Native-only governance.                                                                |
| **Native takeover**         | Attacker buys Native to approve malicious proposal. | Timelock + transparent queue → community can counter; referenda require broader quorum than attack burst.         |
| **Drip Vault exploitation** | Attacker front-runs Drip Vault schedule.            | Small tranche sizes, announced cadence, optional randomization.                                                   |
| **Treasury drain**          | Misconfigured spend empties SODAO treasury.         | Treasury spending not capped but always traceable; community veto via Native; recommended KPI audits (off-chain). |

Attack cost formula (approx):

```
Required vSODT = m × treasury_locked − existing_user_votes + 1
Native cost ≈ Required vSODT × XYK_price (plus slippage)
```

With `m = 3` and substantial treasury holdings, cost scales beyond economic feasibility.

---

## 9. Policy templates & recommended parameters

| Parameter               | Default        | If too low                            | If too high                               |
| ----------------------- | -------------- | ------------------------------------- | ----------------------------------------- |
| `cap_factor`            | 0.99           | Treasury cannot outvote → attack risk | User mint restricted → low liquidity      |
| `timelock_critical`     | 14 days        | Hasty execution, less scrutiny        | Stalled deployments, operational drag     |
| `veto_window`           | 7 days         | Insufficient community reaction time  | Execution delays, contributor frustration |
| `treasury_multiplier m` | 3×             | Weak veto capacity                    | Excessive centralisation risk             |
| `pol_share`             | 35–45%         | Price floor erodes                    | Excess capital lock-up                    |
| `treasury_share`        | 25–35%         | Underfunded operations                | Treasury dominance, lower float           |
| `user_share`            | Remainder      | Illiquid float                        | Excess volatility from large float        |
| `team_share`            | 0% (ecosystem) | No explicit team incentives           | Perceived rent extraction                 |

Overlay fees, curve shapes, and Drip Vault parameters are chosen at launch and can later be adjusted via dual-approval proposals.

---

## 10. Implementation notes (Substrate pallets & hooks)

- `pallet_poldao_registry` — stores launch parameters, cap factor, governance schema, and telemetry targets.
- `pallet_utbc_or_custom` — mint engine supporting multiple curve types. Emits share allocations per mint.
- `pallet_pol_vault` — instantiates XYK pools, tags LP as POL, enforces immutability.
- `pallet_native_proxy` — bridges proposals to Native referenda, tracks veto windows, manages multipliers.
- `pallet_voting_escrow` (optional) — simple deposit/withdraw contract for SODT governance.
- Hooks: `on_mint`, `on_proposal_created`, `on_proposal_passed`, `on_native_vote_result`, `on_timelock_expired`.

All pallets MUST expose on-chain metrics (`floor_native`, `floor_sodt`, `pol_depth_native`, `treasury_locked`, `cap_utilization`).

---

## 11. Deployment roadmap

| Phase                        | Duration    | Parallel work possible?                           |
| ---------------------------- | ----------- | ------------------------------------------------- |
| α (pallet delivery & audits) | 3–6 months  | Yes — audits can overlap late-stage development   |
| β (BLDR pilot)               | 6–12 months | No — learnings should feed forward before scaling |
| γ (contributor expansion)    | 6–12 months | Yes — multiple SODAOs can launch concurrently     |
| δ (open certification)       | 3–6 months  | Yes — templates and onboarding run in parallel    |
| ε (parameter optimisation)   | Ongoing     | Yes — continuous improvement alongside operations |

**Total minimum timeline:** 18–36 months from initiation to a mature ecosystem with multiple SODAOs and telemetry-driven optimisation.

---

## 12. Open variants & extensions

- **Custom mint logic** — integrate algorithms beyond UTBC (e.g., exponential bonding) as long as POL routing and cap checks hold.
- **Treasury multiplier schedules** — dynamic `m(t)` that decays as community distribution increases.
- **Cross-POL stacking** — allow POLDAOs to pair with each other, creating mutual floors subject to additional caps.
- **Insurance vaults** — optional shared reserve funded by participating POLDAOs to cover zap or governance mishaps.
- **BLDR invoice marketplaces** — third-party builders can bid on invoices; BLDR DAO approves and tracks them, turning payroll into an open bazaar.

---

## Closing note

POLDAOs extend UTBC+POL’s bounded-risk paradigm to higher-order economies. By letting the treasury replace the classic team share with proxy voting weight, the system keeps POL immutable, guarantees veto capacity, and enables builders to operate with confidence. The BLDR scenario demonstrates how a single treasury-backed POLDAO can bootstrap an entire contributor economy, while the cap factor and Native veto ensure security across all future branches.

---

- **Version**: 1.0.0
- **Date**: October 2025
- **License**: MIT
