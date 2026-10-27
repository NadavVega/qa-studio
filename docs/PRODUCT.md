# QA Studio
### AI-Powered Quality Engineering Platform for Teams

**Version:** 0.2 — Initial Product Direction  
**Status:** Design only — no code changes

## 1. Product vision

QA Studio is a platform that helps engineering teams understand, investigate and test their web applications using AI.

The platform combines:

- Intelligent test planning.
- Browser and API automation.
- Business-requirement understanding.
- Evidence-based defect investigation.
- Automatic regression-test generation.
- Team collaboration.
- CI/CD integration.

Its primary objective is not to execute as many tests as possible.

**Its objective is to find meaningful defects, explain why they matter, reproduce them reliably and help teams prevent them from returning.**

## 2. Product hierarchy

The fundamental structure will be:

```text
QA Studio
│
├── Organization
│   ├── Team A
│   │   ├── Project 1: E-commerce Application
│   │   │   ├── Development Environment
│   │   │   ├── Staging Environment
│   │   │   ├── Knowledge Base
│   │   │   ├── Investigations
│   │   │   ├── Findings
│   │   │   └── Regression Tests
│   │   │
│   │   └── Project 2: Internal Dashboard
│   │
│   └── Team B
│       └── Project 3: Banking Application
```

Each project has its own configuration, knowledge, credentials, history, evidence and test suite.

Organizations and teams provide access management and collaboration.

One application's knowledge must not influence another application's findings unless explicitly and safely configured.

## 3. The main workflow

Every project follows the same workflow.

### Connect

Register a web application and configure its test environments.

### Understand

Build a structured knowledge base from approved documentation, API specifications, manual requirements and observed application behavior.

### Plan

Generate candidate investigations and prioritize them based on authoritative rules, risk, previous coverage and feasibility.

### Investigate

Execute browser or API actions and collect verifiable evidence.

### Judge

Compare observed behavior against authoritative expectations.

Classify results as correct, observational, inconclusive or potentially defective.

### Validate

Independently reproduce potential defects using fresh evidence.

### Automate

Generate and validate regression-test proposals from confirmed findings.

### Integrate

Allow teams to run approved regression suites through CI/CD and review their results.

## 4. Three execution modes

**Guided Mode**

The engineer controls progression between investigation stages.

The platform shows what each component receives, decides and produces.

This mode is essential for debugging, understanding and auditing AI behavior.

**Assisted Mode**

The platform performs a selected investigation while the engineer supervises.

The engineer can inspect the evidence and intervene at approved checkpoints.

**Autonomous Mode**

The platform plans and executes multiple investigations within predefined boundaries.

Autonomy is limited by environment permissions, execution budgets, available evidence and stopping rules.

Production environments are not treated as unrestricted testing targets.

## 5. Four main product areas

### Projects

Create applications, manage environments, invite team members and configure integrations.

### Workspace

The primary investigation interface.

Displays mission planning, live execution, screenshots, evidence, decisions and execution controls in a connected timeline.

### Quality

Manage findings, validation attempts, regression tests, coverage history and test results.

### Knowledge & Configuration

Manage specifications, authority classifications, unknown requirements, credentials, budgets, integrations and safety policies.

Organization and account administration will be available separately.

## 6. Proposed technical architecture

```text
                    QA STUDIO WEB APP
                           │
                           ▼
                     PLATFORM API
                           │
          ┌────────────────┼─────────────────┐
          │                │                 │
          ▼                ▼                 ▼
    Project Service   QA Intelligence   Run Orchestrator
          │                │                 │
          │                ▼                 ▼
          │           AI Providers       Job Queue
          │                                  │
          │                                  ▼
          │                           Isolated Workers
          │                                  │
          │                            Playwright/API
          │                                  │
          └────────────────┬─────────────────┘
                           │
                     Data Services
                           │
               ┌───────────┴──────────┐
               ▼                      ▼
          PostgreSQL             Evidence Storage
       Projects, runs,          Screenshots, logs,
       rules, findings           traces, recordings
```

This is a proposed logical architecture, not a final infrastructure or technology selection.

### Architectural responsibilities

**Platform API:** Authentication, authorization, project management and application operations.

**QA Intelligence:** Mission planning, deterministic selection, evidence-aware judging and finding validation.

**Run Orchestrator:** Coordinates execution, retries, cancellation and stopping conditions.

**Isolated Workers:** Execute browser and API tests with tightly scoped access.

**Data Services:** Preserve structured records, evidence and audit history.

## 7. Team capabilities

The platform will support:

- Organization and project membership.
- Initial roles: Admin, Engineer and Viewer.
- Shared investigation history.
- Finding assignment and review.
- Reviewable regression-test promotion.
- Project-specific credentials.
- Audit history for important changes.
- GitHub-based CI/CD integration.

The first release will have a minimal permissions model. Advanced enterprise features such as SSO, billing and complex organization policies can come later.

## 8. Non-negotiable engineering principles

1. AI observations must not become authoritative product requirements automatically.
2. AI-generated conclusions must reference real evidence.
3. Potential findings require independent validation.
4. Infrastructure failures must not be classified as product defects.
5. Model instructions must not override execution security policies.
6. Credentials must be managed by the execution infrastructure, not embedded in model prompts.
7. Test data and project information must be isolated between teams.
8. Every execution should have an inspectable history.
9. AI-generated regression tests must pass validation before promotion.
10. Every autonomous session must terminate according to defined rules.

## 9. Initial MVP

The first release should support:

- Multiple projects.
- Multiple users with basic project permissions.
- One configured test environment per project initially.
- Web application testing.
- Guided investigations from the UI.
- AI planning and deterministic selection.
- Browser evidence collection.
- Evidence-aware judging.
- Independent finding validation.
- Regression-test proposals.
- A built-in simulation application.
- Basic shared project history.

Automated CI/CD execution, advanced team administration and full autonomous operation will follow after the core guided workflow is demonstrated.

## 10. Acceptance criteria

The initial product will be considered successful when:

**Scenario 1:** An engineer creates a project and completes an investigation without using the terminal.

**Scenario 2:** Two unrelated web applications are supported without modifying the QA engine.

**Scenario 3:** A simulated defect is detected, independently reproduced and converted into a validated regression-test proposal.

**Scenario 4:** A simulated ambiguous behavior does not become a confirmed defect without sufficient authority and evidence.

**Scenario 5:** Two separate projects cannot access each other's credentials, evidence or findings without authorization.

**Scenario 6:** The user can inspect why a mission was selected and why the Judge reached its conclusion.

**Scenario 7:** The platform safely rejects an investigation that violates an environment or execution policy.

These criteria will guide both implementation and testing.
