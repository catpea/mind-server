/**
 * board-schema.js — Central registry of board constants.
 *
 * All subreddit names, post statuses, and metadata field names used by agents
 * and the server live here. Import these instead of using string literals so
 * renames are caught at one place and typos fail loudly.
 *
 * Usage:
 *   import { SUBS, STATUS, META, SEVERITY, THREAT } from '../board-schema.js';
 *   board.getPosts(SUBS.TODO, { status: STATUS.REVIEW })
 *   meta: { [META.AMY_STATUS]: SEVERITY.APPROVED }
 */

// ── Subreddits ────────────────────────────────────────────────────────────────

export const SUBS = Object.freeze({
  REQUESTS:  'requests',   // user feature requests and bug reports
  TODO:      'todo',       // implementation queue (Monica → Erica → Rita)
  DISPATCH:  'dispatch',   // Vera's dispatch notices
  QUALITY:   'quality',    // code quality findings (Sandra, Alice)
  SECURITY:  'security',   // security findings (Bobby, Mallory, Angela)
  TESTS:     'tests',      // test run results (Alice)
  STANDARDS: 'standards',  // architectural standards (Heather)
  OPS:       'ops',        // operational readiness (Danielle)
  UX:        'ux',         // UX/accessibility findings (Lauren)
  GENERAL:   'general',    // standups and general announcements (Kimberly, Jessica)
});

// ── Post statuses — lifecycle order ──────────────────────────────────────────

export const STATUS = Object.freeze({
  OPEN:               'open',
  PLANNED:            'planned',
  AWAITING_APPROVAL:  'awaiting-approval',
  APPROVED:           'approved',
  IN_PROGRESS:        'in-progress',
  REVIEW:             'review',
  DONE:               'done',
  WONT_FIX:           'wont-fix',
});

// ── Post metadata field names ─────────────────────────────────────────────────

export const META = Object.freeze({
  // Amy triage
  AMY_REVIEWED:   'amyReviewed',
  AMY_STATUS:     'amyStatus',      // 'approved' | 'needs-clarification'

  // Implementation tracking
  FILES_WRITTEN:  'filesWritten',   // string[] — paths written by Erica
  COMMIT_SHA:     'commitSha',      // git commit hash after implementation

  // Cross-post links
  REQUEST_ID:     'requestId',      // request post that spawned this todo
  REQUEST_AUTHOR: 'requestAuthor',  // human who filed the request
  TODO_ID:        'todoId',         // todo post linked from a DM/comment

  // Test tracking
  ALICE_TESTED:   'aliceTested',    // boolean — Alice ran tests for this todo

  // Finding metadata
  SEVERITY:       'severity',       // 'info' | 'warning' | 'error'
  THREAT_LEVEL:   'threatLevel',    // 'low' | 'medium' | 'high' | 'critical'

  // Dispatcher
  DISPATCH_POST_ID: 'dispatchPostId',
});

// ── Enumerated metadata values ────────────────────────────────────────────────

export const AMY_STATUS = Object.freeze({
  APPROVED:           'approved',
  NEEDS_CLARIFICATION:'needs-clarification',
});

export const SEVERITY = Object.freeze({
  INFO:    'info',
  WARNING: 'warning',
  ERROR:   'error',
});

export const THREAT = Object.freeze({
  LOW:      'low',
  MEDIUM:   'medium',
  HIGH:     'high',
  CRITICAL: 'critical',
});
