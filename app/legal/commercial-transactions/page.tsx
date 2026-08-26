import type { Metadata } from "next";
import { LegalArticle, LegalPage } from "@/components/legal/LegalPage";
import { getLegalIdentity } from "@/lib/legal";

export const metadata: Metadata = { title: "特定商取引法に基づく表記 | Staffpass" };

const rows = [
  ["販売業者・役務提供事業者", "providerName"],
  ["通信販売に関する業務の責任者", "responsiblePerson"],
  ["所在地", "address"],
  ["電話番号", "phone"],
] as const;

export default function CommercialTransactionsPage() {
  const identity = getLegalIdentity();
  return (
    <LegalPage title="特定商取引法に基づく表記" description="Staffpassのオンライン申込みおよび継続課金に関する販売条件です。主として法人・団体・個人事業主向けですが、適用される強行法規上の権利を妨げません。" identity={identity}>
      <div className="table-scroll"><table><tbody>
        {rows.map(([label, key]) => <tr key={key}><th>{label}</th><td>{identity[key]}</td></tr>)}
        <tr><th>お問い合わせ</th><td><a href={`mailto:${identity.contactEmail}`}>{identity.contactEmail}</a><br /><span className="text-xs faint">受付内容を確認し、原則として遅滞なく返信します。</span></td></tr>
        <tr><th>サービス名</th><td>Staffpass（AI社員 for Grok Bot）</td></tr>
        <tr><th>販売価格・役務の対価</th><td><ul><li>スターター: 月額12,000円（税込）</li><li>ビジネス: 月額39,800円（税込）</li><li>Managed: 月額128,000円（税込）</li><li>Business初回導入: 150,000円（税込、表示・選択された場合のみ）</li><li>キックオフパック: 398,000円（税込、任意・別途申込み）</li></ul><p className="mt-2 text-xs faint">現在の画面表示価格は事業確定前の設定を含みます。実際の契約価格は、Stripe Checkoutの最終確認画面、見積書または注文書に表示された金額が優先します。価格確定前に課金することはありません。</p></td></tr>
        <tr><th>対価以外に必要な費用</th><td>インターネット接続・通信費、端末費用、契約者が利用するGrok Bot、Google、Telegram、LINEその他外部サービスの料金。確定アクションの超過料金を導入する場合は、申込み前に単価と計測条件を明示します（現時点では自動の超過請求は未実装です）。</td></tr>
        <tr><th>支払方法</th><td>Stripeを通じたクレジットカード決済。銀行振込その他の方法は、当社が個別に認めた場合に利用できます。</td></tr>
        <tr><th>支払時期</th><td>月額料金は、Stripe Checkoutの最終確認画面に表示された初回請求日以降、毎月同日に請求します。初期費用・任意パックは申込時または個別に合意した期日に請求します。銀行振込は請求書記載の期日までにお支払いください。</td></tr>
        <tr><th>役務の提供時期</th><td>アカウントおよびOrgは、登録完了後直ちに利用できます。有料機能は決済または契約手続の完了後に提供します。Managed、初回導入およびキックオフ作業の開始・完了時期は個別に調整します。</td></tr>
        <tr><th>トライアル</th><td>標準14日間。初回登録時にカード情報は不要で、カード未登録のまま自動課金されません。有料申込み時の無料期間、初回請求日および条件はStripe Checkoutの最終確認画面でご確認ください。</td></tr>
        <tr><th>契約期間・自動更新</th><td>月額プランは1か月単位で、解約されるまで自動更新されます。個別の注文書・見積書に期間の定めがある場合は、その定めが優先します。</td></tr>
        <tr><th>解約方法</th><td>次回更新前に、管理画面のStripe Customer Portalまたは {identity.contactEmail} への電子メールで解約をお申し出ください。解約は原則として現在の支払済み期間の終了時に効力を生じ、解約手数料はありません。</td></tr>
        <tr><th>返品・キャンセル・返金</th><td>デジタルサービスの性質上、提供開始後の返品はありません。法令上必要な場合または当社の責に帰すべき提供不能を除き、月途中解約の日割返金、提供済み役務および初期費用の返金は行いません。トライアル期間中に有料申込みをしない場合、料金は発生しません。</td></tr>
        <tr><th>動作環境</th><td>最新版の主要ブラウザ（Chrome、Safari、Edge等）とインターネット接続が必要です。外部AI・通知サービスの利用には各提供者が定める環境とアカウントが別途必要です。</td></tr>
        <tr><th>特別な販売条件</th><td>本サービスは主として業務利用向けです。AIの出力・動作には誤りがあり得るため、重要な操作は人間による確認・承認を設定してください。補助金の採択・交付・金額を保証するものではありません。</td></tr>
      </tbody></table></div>

      <LegalArticle title="表示事項の開示請求">
        <p>上記の販売業者名、所在地、電話番号または運営責任者が「請求があり次第、遅滞なく開示します」と表示されている場合、<a href={`mailto:${identity.contactEmail}`}>{identity.contactEmail}</a> へ件名「特商法表示の開示請求」としてご連絡ください。申込みの意思決定前に確認できるよう、遅滞なく電子メール等でお知らせします。</p>
      </LegalArticle>
    </LegalPage>
  );
}
