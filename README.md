# Audio → MIDI

ブラウザ上で音声ファイルをMIDIへ変換する、local-firstのWebアプリです。

## 特徴

- MP3 / WAV / M4A / AAC / OGG / FLAC / WebMに対応（実際の再生・デコード対応はブラウザ依存）
- Spotify Basic Pitchベースの自動採譜
- ポリフォニック音源に対応
- 音声の解析とMIDI生成をユーザー端末内で実行
- 音声をサーバーへアップロードしない設計
- 最大100 MB / 8分を目安に制限
- GitHub Pagesで静的に公開可能
- モバイル・iPadを含むレスポンシブUI

## 技術構成

- Vite
- Vanilla JavaScript / CSS
- `@musicbento/audio-to-midi`
- Spotify Basic Pitch
- GitHub Actions + GitHub Pages

`@musicbento/audio-to-midi`はブラウザ内でBasic Pitchを使って音声を採譜し、標準MIDIを生成するライブラリです。音声データ自体は外部サービスへ送信せず、AIモデルの取得だけにネットワークを使用します。

## 使い方

```bash
npm install
npm run dev
```

ブラウザで表示されたURLを開き、音声ファイルを選択して「MIDIに変換する」を押します。

本番ビルド:

```bash
npm run build
```

## 精度について

Basic Pitchは楽器を限定しないポリフォニック自動採譜モデルですが、特に単一楽器など、対象の音が明瞭な音源で力を発揮します。完成したMIDIが元音源を完全に再現することを保証するものではありません。

## プライバシー

このアプリは、選択された音声をサーバーへアップロードするバックエンドを持ちません。音声のデコード・推論・MIDI生成はブラウザ側で行います。

なお、初回利用時には採譜モデルなどのWebアセットを取得するためネットワーク通信が発生します。

## ライセンス

このプロジェクト自身のコードは、リポジトリのライセンス方針に従います。

採譜部分ではSpotify Basic Pitchおよび関連するJavaScriptパッケージを利用しています。Basic PitchはApache License 2.0で公開されています。依存パッケージのライセンスもそれぞれの配布物に従います。
