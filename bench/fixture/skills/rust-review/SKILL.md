---
name: rust-review
description: Review Rust ownership, lifetime, and concurrency defects.
allowed-tools: code_search code_references
metadata:
  depends_on:
    - systems-review
  domain_trigger:
    - '\.rs$'
    - match: Cargo.toml
---

# Rust review

Trace ownership across the call graph before judging a lifetime.
