/** Public surface of the write-action services (split by kind; see the sibling modules). */

export { prepareCompletion } from './completion';
export { cancelAction, confirmAction, listActionRecords } from './confirm';
export { fileTypeAccepted, sanitizeFileName } from './filenames';
export { prepareForumPost } from './forum';
export { prepareMessage } from './message';
export { type PrepareSubmissionInput, prepareSubmission } from './submission';
export { countWords, markdownToSimpleHtml, plainTextToHtml } from './text';
