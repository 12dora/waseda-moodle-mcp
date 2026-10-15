import { PublicShell } from '../components/PublicShell';
import { useI18n } from '../i18n';
import { PRIVACY_DOCS, PRIVACY_EFFECTIVE_DATE } from './privacy/content';
import type { PrivacyBlock, PrivacyDoc } from './privacy/types';
import './privacy/privacy.css';

/** Blocks have no id; their first text is unique within a section. */
function blockKey(block: PrivacyBlock): string {
  if ('p' in block) return block.p;
  if ('ul' in block) return block.ul.join('|');
  return block.table.head.join('|');
}

function Block({ block }: { block: PrivacyBlock }) {
  if ('p' in block) return <p>{block.p}</p>;
  if ('ul' in block) {
    return (
      <ul>
        {block.ul.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    );
  }
  const { head, rows } = block.table;
  return (
    <div className="privacy-table-wrap">
      <table>
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row[0]}>
              {row.map((cell) => (
                <td key={cell}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Build-time operator contact; only web and mail links are rendered. */
const CONTACT_URL = ((): string | null => {
  const raw = import.meta.env.VITE_CONTACT_URL?.trim() ?? '';
  return /^(https?:\/\/|mailto:)/i.test(raw) ? raw : null;
})();

function Contact({ contact }: { contact: PrivacyDoc['contact'] }) {
  return (
    <section>
      <h2>{contact.heading}</h2>
      {CONTACT_URL ? (
        <p>
          {contact.label}: <a href={CONTACT_URL}>{CONTACT_URL.replace(/^mailto:/i, '')}</a>
        </p>
      ) : (
        <p>{contact.fallback}</p>
      )}
    </section>
  );
}

/** Public privacy policy; rendered outside config loading, session and router. */
export function PrivacyPage() {
  const { lang } = useI18n();
  const doc = PRIVACY_DOCS[lang];
  return (
    <PublicShell title={doc.title}>
      <article className="privacy">
        <h1 className="page-title">{doc.title}</h1>
        <p className="privacy-meta">
          {doc.effective}: <time dateTime={PRIVACY_EFFECTIVE_DATE}>{PRIVACY_EFFECTIVE_DATE}</time>
        </p>
        {doc.intro.map((p) => (
          <p key={p}>{p}</p>
        ))}
        {doc.sections.map((s) => (
          <section key={s.heading}>
            <h2>{s.heading}</h2>
            {s.blocks.map((b) => (
              <Block key={blockKey(b)} block={b} />
            ))}
          </section>
        ))}
        <Contact contact={doc.contact} />
      </article>
    </PublicShell>
  );
}
