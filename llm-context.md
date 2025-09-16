# Project Context

### Meta-Protocol Principles

Living protocol for continuous self-improvement and knowledge evolution:

1. **Boundary Clarity**: Meta-principles govern the context evolution; project conventions govern the domain specification
2. **Layered Abstraction**: Protocol level ≠ project level; each maintains distinct evolutionary pathways
3. **Mandatory Separation**: Context self-improvement mechanisms must not contaminate project-specific documentation
4. **Domain Purity**: Project conventions should reflect the actual domain (tokenomics, bonding curves, liquidity mechanisms)
5. **Evolutionary Feedback**: Protocol improvements should inform but not override project architectural decisions
6. **Knowledge Hygiene**: Preserve the distinction between "how we document" vs "what we document"
7. **Reflexive Integrity**: The context must model the separation it mandates between protocol and project layers

---

### 1. Overall Concept

A token launch mechanism specification that combines unidirectional bonding curves with automatic protocol-owned liquidity generation through optimized Zap mechanics to create self-sustaining token economies.

---

### 2. Core Entities

- **UTBC+POL**: The main protocol combining Unidirectional Token Bonding Curve with Protocol Owned Liquidity
- **Smart Router**: Primary interface that compares TBC and XYK prices to route transactions optimally
- **Token Bonding Curve (TBC)**: Unidirectional minting mechanism with linear price progression
- **Protocol Owned Liquidity (POL)**: Automatic liquidity generation system that builds permanent protocol liquidity
- **XYK Pool**: Standard AMM pool that provides secondary market for token trading
- **Zap Mechanism**: Optimized liquidity provision strategy that maximizes capital efficiency when adding POL

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

- **Zap-Based Liquidity Addition**: Use intelligent Zap strategy for POL that handles price imbalances
  - **Rationale**: Maximizes liquidity depth when XYK price lags TBC price, adds bulk liquidity first then swaps remainder
  - **Trade-offs**: Additional computational complexity but significantly better capital efficiency

---

### 4. Project Structure

- `/utbc-pol-spec/`: Root directory containing all specification documents
- `UTBC+POL spec. v1.0.0.md`: Initial specification version
- `UTBC+POL spec. v1.1.0.md`: Current specification with Zap mechanism details
- `simulator.js`: JavaScript implementation model for testing protocol mechanics
- `README.md`: Project overview and quick start guide
- `LICENSE`: MIT license file

---

### 5. Development Conventions

- **Documentation**: All changes must be reflected in the specification document with clear rationale
- **Code Examples**: Use Rust for implementation examples to maintain consistency
- **Language**: All documentation and code comments must be in English
- **Mathematical Precision**: All mathematical formulas must be rigorously validated with derivations and edge case analysis
- **Cross-Agent Validation**: External formula reviews reveal subtle scaling issues that may not surface in normal testing
- **Implementation Fidelity**: Code implementations must preserve mathematical correctness even when optimizing for integer arithmetic
- **Documentation Clarity**: Avoid duplication across sections; each concept should appear once in its most logical context
- **KISS Principle**: Balance simplicity with accuracy—oversimplification that distorts core mechanics is worse than appropriate complexity
- **Sequential Abstraction**: Documentation should guide readers logically from problem to solution without assuming prior knowledge
- **Precision Over Brevity**: Never sacrifice correctness for simplicity (e.g., "every purchase creates liquidity" when only TBC routes do)

---

### 6. Pre-Task Preparation Protocol

**Step 1**: Load `/docs/README.md` for documentation architecture
**Step 2**: Integrate entity-specific documentation for task context
**Step 3**: Verify alignment with architectural decisions and conventions
**Step 4**: Document knowledge gaps for future enhancement

---

### 7. Task Completion Protocol

**Step 1**: Verify architectural consistency (sections 3-5)
**Step 2**: Execute quality validation: `N/A - This is a specification project without executable code`
**Step 3**: Update `/docs/README.md` guides for affected entities
**Step 4**: **Mandatory Context Evolution**:

- Analyze architectural impact
- Update sections 1-5 for currency
- Add substantive Change History entry
- Maintain 20-entry maximum

---

### 8. Change History

1. **Context Infrastructure Genesis**:
   - **Task**: Establish self-improving knowledge architecture
   - **Implementation**: Living protocol with systematic accumulation patterns
   - **Impact**: Foundation for architectural consistency and progressive understanding

2. **Protocol Template Evolution**:
   - **Task**: Update context to current protocol template with meta-principles
   - **Implementation**: Migrated from legacy format to Protocol 2 structure
   - **Impact**: Enhanced self-improvement capabilities and knowledge management
   - **Key Insight**: Discovered critical distinction between protocol-level meta-principles and project-specific conventions

3. **Layer Boundary Clarification**:
   - **Task**: Separate protocol self-improvement mechanisms from domain-specific conventions
   - **Implementation**: Removed meta-principles contamination from project conventions section
   - **Impact**: Established clear separation between "how context evolves" vs "what the project actually does"
   - **Architectural Insight**: Protocol-level abstractions (evolution, enhancement) must not dictate project-level implementation details

4. **UTBC+POL v1.1.0 Specification with Zap Mechanics**:
   - **Task**: Create refined specification v1.1.0 with detailed Zap mechanism based on JS model insights
   - **Implementation**: Added comprehensive Zap strategy details while maintaining minimalist style, clarified buffer management and capital efficiency
   - **Impact**: Specification now accurately reflects the sophisticated liquidity provision strategy that maximizes LP depth
   - **Key Discovery**: Zap is specifically optimized for UTBC+POL dynamics where XYK price naturally lags TBC, enabling bulk liquidity addition followed by remainder swaps

5. **Critical Formula Validation and Precision Fix**:
   - **Task**: Investigate and resolve mint calculation precision issues identified through cross-agent mathematical review
   - **Implementation**: Fixed critical scaling bug in `calculate_mint()` by removing extra PRECISION factor from coefficient c
   - **Impact**: Resolved precision loss for small amounts and overflow risks for large amounts while preserving mathematical correctness
   - **Mathematical Insight**: Discovered that current formula structure is mathematically sound despite apparent PPM inconsistency—the quadratic equation scaling creates self-consistent coefficient ratios
   - **Validation Methodology**: External agent review revealed problems invisible to author, highlighting importance of mathematical cross-validation
   - **Layered Understanding**: Surface-level "inconsistencies" may mask deeper mathematical elegance; investigate before replacing working systems

6. **README Refinement and Documentation Abstraction**:
   - **Task**: Update README.md to align with v1.1.0 specification and eliminate conceptual duplication
   - **Implementation**: Restructured to two focused sections (Core Concept, Key Mechanics) removing redundant Overview/How it Works/Key Features structure
   - **Impact**: Created clear, sequential narrative that accurately describes system without oversimplification or duplication
   - **Documentation Insight**: Discovered critical balance between simplicity and accuracy—oversimplification (e.g., "every purchase creates liquidity") distorts understanding more than appropriate technical detail
   - **Abstraction Lesson**: Multiple attempts revealed that extreme minimalism can sacrifice correctness; final version achieved KISS without losing precision
   - **Reader Navigation**: Effective documentation guides readers sequentially through problem→solution→mechanics→result without assuming context
