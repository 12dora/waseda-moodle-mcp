/** Loose shapes of core_course_get_contents (boundary only; every field optional). */

export interface RawContentFile {
  type?: string;
  filename?: string;
  filesize?: number;
  fileurl?: string;
  mimetype?: string | null;
  timemodified?: number;
}

export interface RawDate {
  label?: string;
  timestamp?: number;
  dataid?: string | null;
}

export interface RawModule {
  id?: number;
  name?: string;
  modname?: string;
  url?: string;
  description?: string;
  visible?: number | boolean;
  uservisible?: boolean;
  completion?: number;
  completiondata?: { state?: number; hascompletion?: boolean } | null;
  dates?: RawDate[] | null;
  contents?: RawContentFile[] | null;
}

export interface RawSection {
  id?: number;
  name?: string;
  section?: number;
  summary?: string;
  uservisible?: boolean;
  modules?: RawModule[] | null;
}
