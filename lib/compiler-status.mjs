// React Compiler statuses that need no fix: memoized, or an error boundary (React has error
// boundaries only as class components, which the compiler does not compile). lib/dashboard.html
// repeats this check, since the page does not load modules.
export const EXPECTED_STATUSES = ['compiled', 'error-boundary'];

// A component the compiler could have memoized but did not (null: no compiler data).
export const isNotMemoized = status => status != null && !EXPECTED_STATUSES.includes(status);
