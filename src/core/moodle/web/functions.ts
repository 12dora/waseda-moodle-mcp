/** The web-service functions the web channel emulates (adapters), keyed by function name. */

import { assignFunctions } from './adapters/assign';
import { calendarFunctions } from './adapters/calendar';
import { contentFunctions } from './adapters/content';
import { courseFunctions } from './adapters/course';
import { forumFunctions } from './adapters/forum';
import { gradeFunctions } from './adapters/grades';
import { identityFunctions } from './adapters/identity';
import { messageFunctions } from './adapters/messages';
import { quizFunctions } from './adapters/quiz';
import type { WebFunctions } from './types';

export const WEB_FUNCTIONS: WebFunctions = {
  ...identityFunctions,
  ...courseFunctions,
  ...calendarFunctions,
  ...assignFunctions,
  ...quizFunctions,
  ...forumFunctions,
  ...messageFunctions,
  ...gradeFunctions,
  ...contentFunctions,
};
