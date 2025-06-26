# Project Context

### Meta-Protocol Principles

This document is a **living protocol** designed for continuous, intelligent self-improvement. Its core principles are:

1.  **Decreasing Abstraction**: Always structure information from the general to the specific.
2.  **Mandatory Self-Improvement**: Every task must end with an update to this document.
3.  **Protocol Evolution**: The rules themselves, especially the Task Completion Protocol, should be improved if a more efficient workflow is discovered.

---

### 1. Overall Concept

- A token launch mechanism specification that combines unidirectional bonding curves with automatic protocol-owned liquidity generation to create self-sustaining token economies.

---

### 2. Core Entities

- **UTBC+POL**: The main protocol combining Unidirectional Token Bonding Curve with Protocol Owned Liquidity
- **Smart Router**: Primary interface that compares TBC and XYK prices to route transactions optimally
- **Token Bonding Curve (TBC)**: Unidirectional minting mechanism with linear price progression
- **Protocol Owned Liquidity (POL)**: Automatic liquidity generation system that builds permanent protocol liquidity
- **XYK Pool**: Standard AMM pool that provides secondary market for token trading

---

### 3. Architectural Decisions

- **Unidirectional Minting**: Use one-way token creation only (no burning through TBC)
  - **Rationale**: Prevents complete reserve extraction and provides predictable token economics
  - **Trade-offs**: Limits flexibility compared to bidirectional curves

- **Linear Pricing Model**: Implement linear price progression for the bonding curve
  - **Rationale**: Ensures fairness and predictability for all participants
  - **Trade-offs**: May be less capital efficient than exponential curves

- **Automatic POL Formation**: Allocate portion of each mint to protocol-owned liquidity
  - **Rationale**: Creates self-sustaining liquidity without external providers
  - **Trade-offs**: Reduces immediate token allocation to buyers

---

### 4. Project Structure

- `/utbc-pol-spec/`: Root directory containing all specification documents
- `UTBC+POL spec. v1.0.0.md`: Current version for reference
- `README.md`: Project overview and quick start guide
- `LICENSE`: MIT license file

---

### 5. Development Conventions

- **Documentation**: All changes must be reflected in the specification document with clear rationale
- **Code Examples**: Use Rust for implementation examples to maintain consistency
- **Language**: All documentation and code comments must be in English
- **Mathematical Accuracy**: All mathematical formulas must be rigorously validated and include proper derivations

---

### 6. Task Completion Protocol

Every task must be concluded by strictly following this protocol. This ensures consistency and knowledge accumulation.

**Step 1: Verify Changes.** Ensure all changes align with the principles outlined in sections 3, 4, and 5 of this document.

**Step 2: Specification Version Check.** If a new version of the `UTBC+POL` specification has been created:

1. Update the README.md to reference the new version number in the "Learn More" section
2. Ensure the link points to the correct specification file
3. Update any version-specific information if the changes are significant

**Step 3: Code Check.** If applicable, run the primary code quality check command (e.g., a linter or test runner) and ensure it passes without errors.

`N/A - This is a specification project without executable code`

**Step 4: Update Context.** This is the **final action** before completing the task. You must update **this file (`llm-context.md`)** to reflect the changes made.

1.  **Analyze your changes**: What new project information (entities, architectural decisions, conventions) did you add or modify
2.  **Update relevant sections**: Modify sections 1-5 as needed to keep the document current.
3.  **Add a history entry**: Add a new, uniquely numbered entry to the bottom of the "Change History" section. The number must always increment.
4.  **Rotate History**: Ensure that the "Change History" section contains no more than the 20 most recent entries. Remove the oldest entry if the count exceeds 20.

---

### 7. Change History

Entries are numbered in chronological order. The list should not exceed 60 entries.

1.  **Context Initialization**:
    - **Task**: Initialize the project's knowledge base.
    - **Implementation**: This document was created to centralize project knowledge and establish a self-improving protocol.
    - **Rationale**: To provide a single source of truth, ensuring consistent and efficient development from the outset.
    - **Impact on Context**: The foundation for systematic knowledge accumulation is now in place.
