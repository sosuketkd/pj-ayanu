// Email sending via Resend (https://resend.com) — HTTP API, no SDK dependency.
// Configure with env vars:
//   RESEND_API_KEY  … Resend API key (if unset, email is skipped gracefully)
//   EMAIL_FROM      … From header (default: 綾整(Ayanu) <notify@ayanu.sixma.jp>)
const RESEND_API_KEY = process.env.RESEND_API_KEY;
// ASCII display name by default for deliverability; override via EMAIL_FROM if desired.
const EMAIL_FROM = process.env.EMAIL_FROM || 'Ayanu <notify@ayanu.sixma.jp>';

type SendResult = { sent: boolean; skipped?: boolean; error?: string };

export function emailEnabled(): boolean { return !!RESEND_API_KEY; }

export async function sendEmail(
  { to, subject, html, text }: { to: string; subject: string; html: string; text: string },
): Promise<SendResult> {
  if (!RESEND_API_KEY) {
    console.warn('[ayanu] RESEND_API_KEY not set — skipping email to', to);
    return { sent: false, skipped: true };
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: EMAIL_FROM, to: [to], subject, html, text }),
    });
    if (!res.ok) {
      console.error('[ayanu] email send failed', res.status, await res.text().catch(() => ''));
      return { sent: false, error: `email ${res.status}` };
    }
    return { sent: true };
  } catch (e) {
    console.error('[ayanu] email send error', e);
    return { sent: false, error: 'email exception' };
  }
}

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
function esc(s: unknown): string {
  return String(s).replace(/[&<>"]/g, (ch) => ESC[ch]);
}

export async function sendInviteEmail(
  { to, workspaceName, acceptUrl, role, inviter }:
  { to: string; workspaceName: string; acceptUrl: string; role: string; inviter: string },
): Promise<SendResult> {
  const roleJa = role === 'admin' ? '管理者' : 'メンバー';
  const subject = `「${workspaceName}」への招待 — 綾整(Ayanu)`;
  const text =
    `${inviter} さんがあなたを 綾整(Ayanu) のワークスペース「${workspaceName}」に` +
    `${roleJa}として招待しました。\n\n以下のリンクから参加してください（このメールアドレスでログイン/登録が必要です）:\n` +
    `${acceptUrl}\n`;
  const html = `
  <div style="font-family:-apple-system,Segoe UI,Hiragino Kaku Gothic ProN,sans-serif;max-width:480px;margin:0 auto;color:#1f2733">
    <h2 style="font-size:18px">📋 綾整(Ayanu) への招待</h2>
    <p style="font-size:14px;line-height:1.7">
      <b>${esc(inviter)}</b> さんが、ワークスペース
      「<b>${esc(workspaceName)}</b>」に <b>${roleJa}</b> として招待しました。
    </p>
    <p style="margin:24px 0">
      <a href="${esc(acceptUrl)}" style="background:#3b82f6;color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;font-weight:700;font-size:14px;display:inline-block">参加する</a>
    </p>
    <p style="font-size:12px;color:#8a94a3;line-height:1.6">
      このメールアドレス（${esc(to)}）でログインまたは新規登録すると参加できます。<br>
      ボタンが押せない場合はこちらのURLを開いてください:<br>
      <span style="word-break:break-all">${esc(acceptUrl)}</span>
    </p>
  </div>`;
  return sendEmail({ to, subject, html, text });
}
