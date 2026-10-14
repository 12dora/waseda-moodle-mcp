import type { McpServer } from '@modelcontextprotocol/server';

const userPrompt = (lines: string[]) => ({
  messages: [{ role: 'user' as const, content: { type: 'text' as const, text: lines.join('\n') } }],
});

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'daily_briefing',
    {
      title: 'Daily briefing',
      description:
        'Overdue and upcoming deadlines for the next 3 days plus unread notifications, as a short plan for today.',
    },
    () =>
      userPrompt([
        'Give me my Waseda Moodle briefing for today.',
        '1. Call get_due_items with days_ahead=3 and overdue_days=14.',
        '2. Call list_notifications with unread_only=true and limit=10; if there are unread items, also call list_messages with unread_only=true and limit=5.',
        'Then write a concise plan: first anything overdue or due within 24 hours (exact JST time; a 00:00 deadline means the previous day 24:00), then what follows in the next 3 days, then unread items worth reading.',
        'Suggest an order of work for today with rough effort. Do not submit, post or send anything.',
      ]),
  );

  server.registerPrompt(
    'weekly_plan',
    {
      title: 'Weekly plan',
      description: 'Everything due in the next 7 days grouped by day, with effort estimates and a suggested schedule.',
    },
    () =>
      userPrompt([
        'Plan my next 7 days of Waseda Moodle work.',
        '1. Call get_due_items with days_ahead=7 and overdue_days=7.',
        '2. For the larger assignments call get_activity to read the requirements before estimating effort.',
        'Then group the work by day (JST; a 00:00 deadline means the previous day 24:00), give a rough effort estimate for each item in hours, point out days that are overloaded, and propose when to work on what.',
        'Do not submit, post or send anything.',
      ]),
  );
}
