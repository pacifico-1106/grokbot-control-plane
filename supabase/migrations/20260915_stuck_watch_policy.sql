-- F7 Stuck Watch: org-level policy for stuck detection and safe reinvoke

alter table orgs
  add column if not exists stuck_watch_policy jsonb default null;

comment on column orgs.stuck_watch_policy is 'F7 stuck watch policy: enabled, mentionUnansweredMinutes, approvedUnfulfilledMinutes, maxAutoRetries, retryBackoffSeconds, autoRetryFaultClasses, notifyMouth, inferInternalAudienceFromLedger';
