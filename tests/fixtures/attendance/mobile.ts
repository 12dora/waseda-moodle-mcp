/**
 * Invented mobile_view_activity HTML in the shape of mod_attendance/mobile_view_page_latest
 * (ion-grid of plugin.mod_attendance.* keys, optional ion-item sessions). Not live data.
 */

export interface FixtureSession {
  time: string;
  group?: string;
  status?: string;
  remarks?: string;
  canSubmit?: boolean;
}

export interface FixtureSummary {
  taken: string;
  points: string;
  percentage: string;
  total: string;
  pointsAll?: string;
  percentageAll: string;
  maxPoints: string;
  maxPercentage: string;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function sessionItem(s: FixtureSession): string {
  const button = s.canSubmit
    ? `<ion-button core-site-plugins-new-content component="mod_attendance" method="mobile_user_form">
                {{ 'plugin.mod_attendance.submitattendance' | translate }}
            </ion-button>`
    : '';
  const remarks = s.remarks !== undefined ? `\n            <h3>${s.remarks}</h3>` : '';
  return `    <ion-item>
        <ion-label>
            <h2>${s.time}</h2>
            <h3>${s.group ?? ''}</h3>
            <h3>${s.status ?? ''}</h3>${remarks}
            ${button}
        </ion-label>
    </ion-item>`;
}

function row(key: string, value: string): string {
  return `        <ion-row>
            <ion-col size="9" class="text-left ion-text-wrap">
                {{ 'plugin.mod_attendance.${key}' | translate }}
            </ion-col>
            <ion-col size="2" class="text-left">
                ${value}
            </ion-col>
        </ion-row>`;
}

/** One mobile template, same tags/classes as the live handler. Numbers and copy are invented. */
export function attendanceMobileHtml(opts: {
  cmid?: number;
  intro?: string;
  summary?: Partial<FixtureSummary>;
  sessions?: FixtureSession[];
  message?: string;
}): string {
  const cmid = opts.cmid ?? 7012;
  const intro = opts.intro ?? '<p>Friday in-person sessions are recorded here.</p>';
  const s: FixtureSummary = {
    taken: '6',
    points: '12 / 18',
    percentage: '66.7%',
    total: '15',
    pointsAll: '66.7%',
    percentageAll: '40.0%',
    maxPoints: '24 / 30',
    maxPercentage: '80.0%',
    ...opts.summary,
  };
  const msg = opts.message
    ? `    <span class="messages">
        <ion-item class="ion-text-wrap">
            <ion-label>{{ 'plugin.mod_attendance.${opts.message}' | translate }}</ion-label>
        </ion-item>
    </span>\n`
    : '';
  const sessions = (opts.sessions ?? []).map(sessionItem).join('\n');
  return `<div class="attendance_mobile_view_page">
    <core-course-module-info [module]="module" description="${esc(intro)}"
        component="mod_attendance" componentId="${cmid}" [courseId]="courseId">
    </core-course-module-info>
${msg}${sessions ? `${sessions}\n` : ''}    <ion-item>
    <ion-label>
    <ion-grid>
${row('sessionscompleted', s.taken)}
${row('pointssessionscompleted', s.points)}
${row('percentagesessionscompleted', s.percentage)}
${row('sessionstotal', s.total)}
${row('pointsallsessions', s.pointsAll ?? s.percentage)}
${row('percentageallsessions', s.percentageAll)}
${row('maxpossiblepoints', s.maxPoints)}
${row('maxpossiblepercentage', s.maxPercentage)}
    </ion-grid>
    </ion-label>
    </ion-item>
</div>`;
}

export const ATTENDANCE_SUMMARY_ONLY = attendanceMobileHtml({
  intro: '<p>Please come to class on time.</p>',
  sessions: [],
});

export const ATTENDANCE_WITH_SESSIONS = attendanceMobileHtml({
  intro: '<p>Weekday sessions. <strong>On time</strong> is two points.</p>',
  sessions: [
    {
      time: '<nobr>Fri 02 Oct 2026</nobr> 01:00PM - 02:40PM',
      status: 'Absent',
      remarks: 'sick',
    },
    {
      time: '<nobr>Fri 09 Oct 2026</nobr> 01:00PM - 02:40PM',
      group: 'Group A',
      status: 'P — Present',
    },
    { time: '2026年 10月 16日(金曜日) 13:00', status: 'Late' },
  ],
});
