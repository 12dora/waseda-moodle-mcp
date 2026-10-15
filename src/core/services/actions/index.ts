/** Public surface of the write-action services (split by kind; see the sibling modules). */

export { prepareCompletion } from './completion';
export { cancelAction, confirmAction, listActionRecords } from './confirm';
export { fileTypeAccepted, sanitizeFileName, unverifiableTypes } from './filenames';
export { prepareForumPost } from './forum';
export { prepareForumSubscription } from './forum-subscription';
export { prepareMessage } from './message';
export { prepareMarkRead } from './read-state';
export { type PrepareSubmissionInput, prepareSubmission } from './submission';
export { countCjkChars, countWords, markdownToSimpleHtml, plainTextToHtml } from './text';
