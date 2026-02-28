# Wind 瀹㈡埛绔珵鍝佹繁搴﹀垎鏋愭姤鍛?
> 鍒嗘瀽鏃ユ湡锛?026-02-27 | 鏁版嵁鏉ユ簮锛氭姄鍖呭垎鏋?+ 鏈湴瀹㈡埛绔?API 閫嗗悜 + Windsurf 瀹樻柟鏂囨。

---

## 涓€銆佺珵鍝佹鍐?
| 缁村害 | 璇︽儏 |
|------|------|
| **浜у搧鍚嶇О** | Wind 瀹㈡埛绔紙windsurf-LG锛?|
| **鐗堟湰** | 1.0.0.10 |
| **鍩熷悕浣撶郴** | API: `win01.lgtc.top`锛屼唬鐞嗚妭鐐? `windocker02-05.lgtc.top` |
| **CDN** | 鑵捐浜戝浗闄?CDN锛坄intlscdn.com`锛夛紝闅愯棌鐪熷疄 IP |
| **瀹㈡埛绔?* | Windows EXE锛?6.28 MB锛岄渶绠＄悊鍛樻潈闄?|
| **鎶€鏈爤** | Go 鍚庣 + 鏈湴 Web UI锛圚TML/CSS/JS on `:18921`锛?|
| **鐩爣鐢ㄦ埛** | 涓浗寮€鍙戣€咃紝闇€瑕佷綆鎴愭湰浣跨敤 Windsurf Cascade 鍏ㄦā鍨?|
| **浜у搧瀹氫綅** | Windsurf MITM 浠ｇ悊鍏变韩鏈嶅姟锛屾寜澶?鎸夐噺璁¤垂 |
| **鐢ㄦ埛瑙勬ā** | 褰撳墠鐢ㄦ埛 ID 宸插埌 96+锛坄user_id: 96`锛夛紝瀹為檯娲昏穬鐢ㄦ埛鏈煡 |

---

## 浜屻€佸畬鏁村椁愪綋绯?
绔炲搧鎻愪緵 **涓ゅぇ绫?7 涓椁?*锛屾暟鎹潵婧愪簬 `GET http://127.0.0.1:18921/api/plans`銆?
### 2.1 鍖呴噺濂楅锛堜竴娆℃€ц喘涔帮紝鐢ㄥ畬鍗虫锛?
| 濂楅 | 鍐呴儴鍚?| 浠锋牸 | 绉垎 | 鏈夋晥鏈?| 鍗曠Н鍒嗕环 | 鍞悗 |
|------|--------|------|------|--------|----------|------|
| 璇曠敤濂楅 | `100_bl` | 楼4.5 | 100 | 365澶?| 楼0.045 | 涓嶅寘鍞悗 |
| 鍩虹濂楅 | `500_bl` | 楼21 | 500 | 365澶?| 楼0.042 | 鎸夊墿浣欑Н鍒嗛€€ |
| 涓撲笟濂楅 | `1000_bl` | 楼40 | 1,000 | 365澶?| 楼0.040 | 鎸夊墿浣欑Н鍒嗛€€ |
| 鏃楄埌鐗堝椁?| `2000_bl` | 楼76 | 2,000 | 365澶?| 楼0.038 | 鎸夊墿浣欑Н鍒嗛€€ |

**鐗圭偣**锛?- 鏃犳仮澶嶆満鍒讹紙`recovery_interval: 0`锛?- 绉垎鐢ㄥ畬灏辨病浜嗭紝浣嗘湁鏁堟湡闀胯揪涓€骞?- 閲忚秺澶у崟浠疯秺浣庯紙楼0.045 鈫?楼0.038锛?- 鎻忚堪鍧囨爣娉?pro鍙锋睜锛屼笉闄愰€燂紝涓嶉檷鏅?

### 2.2 鍖呮椂濂楅锛堟寜澶╄璐癸紝绉垎瀹氭湡鎭㈠锛?
| 濂楅 | 鍐呴儴鍚?| 浠锋牸 | 绉垎涓婇檺 | 鎭㈠闂撮殧 | 鎭㈠閲?| 妯″瀷 | 鐗规畩鏍囪 |
|------|--------|------|----------|----------|--------|------|----------|
| 鍩虹鐗?| `basic` | 楼9.9/澶?| 1,000 | **5灏忔椂** | 1,000锛堝叏閲忥級 | 鍏ㄦā鍨?| 鈥?|
| 涓撲笟鐗?| `pro` | 楼15.88/澶?| 1,000 | **3灏忔椂** | 1,000锛堝叏閲忥級 | 鍏ㄦā鍨?| `fast` |
| 鏃楄埌鐗?| `premium` | 楼25/澶?| 1,000 | **1灏忔椂** | 1,000锛堝叏閲忥級 | 鍏ㄦā鍨?| `fast` + `priority` |

**鐗圭偣**锛?- 涓夋。鍧囦负**鍏ㄦā鍨嬭闂?*锛堝疄闄呬娇鐢ㄧ‘璁わ紝涓夋。閮芥敮鎸?Claude Opus銆丟PT-5 绛夋墍鏈夋ā鍨嬶級
- 绉垎鎭㈠鏄?*鍏ㄩ噺閲嶇疆**锛堢洿鎺ュ洖鍒?1000锛夛紝涓嶆槸澧為噺
- 鏍稿績宸紓鍙湁涓€涓細**鎭㈠闂撮殧**锛?h / 3h / 1h锛?- `fast` 鏍囪锛氭帹娴嬫槸浠ｇ悊闃熷垪涓殑浼樺厛绾э紙璇锋眰鏇村揩鍒嗛厤璐﹀彿锛?- `priority` 鏍囪锛氭渶楂樹紭鍏堢骇锛堣处鍙锋睜绻佸繖鏃朵紭鍏堟湇鍔★級
- 閫€娆炬柟寮忥細鍩虹鐗堟寜鍓╀綑灏忔椂閫€

### 2.3 濂楅鏃ュ悶鍚愰噺浼扮畻锛堟寜 credits 鍙ｅ緞锛?
| 濂楅 | 鎭㈠闂撮殧 | 鐞嗚鏃ュ彲鐢ㄧН鍒?| 鑻ュ叏鐢?Opus锛?0 credits/娆★級鍙彂娑堟伅 | 鑻ュ叏鐢?0.5 绉垎妯″瀷鍙彂娑堟伅 |
|------|----------|----------------|--------------------------------------|------------------------------|
| 鍩虹鐗?| 5h | 1000 x (24/5) = **4,800** | **240** | **9,600** |
| 涓撲笟鐗?| 3h | 1000 x (24/3) = **8,000** | **400** | **16,000** |
| 鏃楄埌鐗?| 1h | 1000 x (24/1) = **24,000** | **1,200** | **48,000** |

> 鍚屾牱 1000 绉垎锛屽湪涓嶅悓妯″瀷涓嬪彲鍙戦€佹秷鎭暟鍙浉宸嚑鍗佸€嶃€傛仮澶嶉棿闅旀湰璐ㄤ笂鏄湪鎺у埗鐢ㄦ埛鐨勭灛鏃舵秷鑰椾笂闄愪笌绛夊緟鏃堕暱銆?
---

## 涓夈€佺Н鍒嗙郴缁熻璁?
### 3.1 Windsurf 瀹樻柟绉垎鍙ｅ緞锛堝熀绾匡級

**Windsurf 瀹樻柟绉垎浣撶郴**锛堟潵婧愶細docs.windsurf.com锛夛細

> "When you send a message to Cascade with a premium model, **1 prompt credit is consumed**. It doesn't matter how many actions Cascade takes to fulfill your request -- whether it searches your codebase, analyzes files, or makes edits -- **you only pay for the initial prompt**."

Windsurf 瀹樻柟鏄?*鎸夎姹傦紙per-prompt锛?*璁¤垂锛屼笉鍚屾ā鍨嬫湁涓嶅悓绉垎鍊嶇巼锛?
| 妯″瀷 | 瀹樻柟绉垎娑堣€?娆?| 璁¤垂鏂瑰紡 |
|------|----------------|---------|
| SWE-1 / SWE-1 Lite | **0** | 鍏嶈垂 |
| GPT-5 Low / Kimi K2 / Qwen3-Coder | **0.5** | 鎸夋鍥哄畾 |
| Gemini 2.5 Pro | **1** | 鎸夋鍥哄畾 |
| GPT-5 High Reasoning | **1.5** | 鎸夋鍥哄畾 |
| Claude Sonnet 4 | **鎸?token** | Input 90/1M, Output 450/1M |
| Claude Opus 4.1 Thinking | **~20** | 鎸夋鍥哄畾 |

### 3.2 鍙嬪晢绉垎绛栫暐锛堜慨璁級

鍩轰簬鏈€鏂板疄娴嬶紝鍙嬪晢绉垎搴旂悊瑙ｄ负**瀵规爣 Windsurf credits**锛岃€岄潪鈥滄瘡鏉℃秷鎭浐瀹?1 绉垎鈥濄€?
瀹炴祴鐜拌薄锛堢煭瀵硅瘽锛夛細
- 浣欓浠?`850 -> 790 -> 760`
- 涓ゆ绠€鐭棶绛旂疮璁℃秷鑰楃害 `60` 鍒嗭紝绾?`30` 鍒?娆?- 璇ラ噺绾ф槑鏄句笉绗﹀悎鈥? 娆?1 鍒嗏€濓紝鏇存帴杩戦珮鎴愭湰妯″瀷 credits 鎵ｅ噺

**淇缁撹**锛氬弸鍟嗙Н鍒嗕笌 Windsurf credits 鍚岄噺绾诧紝鍓嶅彴绉垎澶ф鐜囨槸搴曞眰 credits 鐨勯€忎紶鎴栬繎浼兼槧灏勶紙`k鈮?`锛夈€?
鍙兘鐨勬墸鍑忓叧绯伙細

```
鍙嬪晢鍓嶅彴鎵ｅ噺绉垎 鈮?Windsurf 瀹為檯娑堣€?credits 脳 绯绘暟 k
鍏朵腑 k 鎺ヨ繎 1锛堝叿浣撴槸鍚﹀畬鍏?1:1 浠嶉渶鏇村鏍锋湰楠岃瘉锛?```

搴曞眰娴佽浆锛堜慨璁級锛?
```
鐢ㄦ埛鍙?1 鏉?Cascade 娑堟伅
  -> 鍙嬪晢浠ｇ悊鎸夋ā鍨?涓婁笅鏂囨垚鏈墸鍑忕敤鎴风Н鍒嗭紙闈炲浐瀹?1 鍒嗭級
  -> 搴曞眰娑堣€?Windsurf 璇曠敤鍙峰搴?credits
  -> 鍒版仮澶嶆椂闂村悗閲嶇疆鍒板椁愪笂闄愶紙濡?1000锛?```

杩欒В閲婁簡鍏垛€?000 绉垎 + 5h 鍒锋柊鈥濆椁愶細鏈川鏄湪鍞崠涓€娈垫椂闂村唴鐨?credits 浣跨敤绐楀彛锛岃€屼笉鏄浐瀹氭秷鎭潯鏁板寘銆?
### 3.3 鍙嬪晢杩愯惀绛栫暐锛堟寜 credits 鍙ｅ緞锛?
1. **绉垎鍙ｅ緞涓庝笂娓镐竴鑷?*锛氱敤鎴蜂晶绉垎鐩存帴閿氬畾 Windsurf credits锛岃吹妯″瀷鑷劧鏇村揩鑰楀敖銆?2. **鐢ㄥ埛鏂伴棿闅斿仛鎴愭湰闂搁棬**锛?h/3h/1h 涓嶆槸绠€鍗曗€滃姞閫熷寘鈥濓紝鑰屾槸涓嶅悓鐨勬垚鏈噴鏀鹃€熺巼銆?3. **浼樺厛绾у垎灞傝€岄潪妯″瀷鍒嗗眰**锛歚fast` / `priority` 鏇村儚鎺掗槦鏉冮噸锛岀紦瑙ｉ珮宄版嫢濉炪€?4. **鎴愭湰娉㈠姩鐢卞彿姹犲惛鏀?*锛氬綋鐢ㄦ埛闆嗕腑浣跨敤 Opus锛屽彿姹犳秷鑰椾細鎬ュ墽涓婂崌銆?
### 3.4 Windsurf 璇曠敤鍙风Н鍒嗚鎯?
| 鎸囨爣 | 鍊?| 鏉ユ簮 |
|------|------|------|
| Pro Trial 绉垎 | 100 credits | Windsurf 瀹樻柟鏂囨。 |
| 璇曠敤鏈?| 14 澶?| 瀹樻柟鏂囨。 |
| 鎶撳寘瑙傛祴鍊?| 30 credits锛坒ield 4锛?| `CheckUserMessageRateLimit` 鍝嶅簲 |

> 娉細鎶撳寘鏃惰娴嬪埌 30 credits 鍙兘鏄棫鐗堟湰鎴栧凡閮ㄥ垎娑堣€楃殑璐﹀彿銆傚畼鏂规枃妗ｅ綋鍓嶆爣娉?Pro Trial 涓?100 credits銆?
---

## 鍥涖€佸彿姹犺处鍙蜂笌鐢ㄦ埛璐﹀彿鐨勮繛鎺ユ柟妗堬紙鏍稿績鏋舵瀯锛?
### 4.1 鎬讳綋鏋舵瀯

```
Windsurf IDE                    鍙嬪晢瀹㈡埛绔?EXE                  鍙嬪晢浠ｇ悊鑺傜偣
+----------------+        +---------------------+        +--------------------+
|                | HTTPS  |  鏈湴 MITM 浠ｇ悊      | HTTPS  |  windocker03       |
|  Cascade       | -----> |  127.0.0.1:443      | -----> |  .lgtc.top:443     |
|  璇锋眰          |        |                     |        |                    |
|                |        |  + Web UI :18921    |        |  楠岃瘉鐢ㄦ埛          |
|  鐩爣鍩熷悕:     |        |  + MITM CA 璇佷功     |        |  閫夊彿姹犺处鍙?       |
|  server.       |        |  + hosts 鍔寔       |        |  鏇挎崲 API Key      |
|  self-serve.   |        |                     |        |  杞彂鍒?Windsurf   |
|  windsurf.com  |        +---------------------+        +---------+----------+
+----------------+                                                 |
                                                                   | HTTPS
                                                                   v
                                                     Windsurf 瀹樻柟鍚庣
                                                     server.self-serve.windsurf.com
                                                     (Google Cloud)
```

### 4.2 杩炴帴鏈哄埗璇﹁В锛歅rotobuf 绾?API Key 鏇挎崲

**鏍稿績鍙戠幇**锛堟潵鑷姄鍖呭垎鏋?analysis.md S9.3锛夛細

> Windsurf 鐨勮璇?*涓嶆槸**閫氳繃 HTTP `Authorization` header锛岃€屾槸**宓屽叆鍦?Protobuf 璇锋眰浣撳唴閮?*銆傛瘡涓?API 璋冪敤鐨?protobuf body 閮藉寘鍚細
> - API Key锛坄gsk-xxx` 鏍煎紡锛?> - JWT Token锛堝惈瀹屾暣鐢ㄦ埛韬唤淇℃伅锛?
鍙嬪晢鐨勪唬鐞嗗仛鐨勬槸锛?*鍦?Protobuf 浜岃繘鍒跺眰闈㈡浛鎹?API Key 鍜?JWT 瀛楁**銆?
### 4.3 瀹屾暣璇锋眰鐢熷懡鍛ㄦ湡

```
姝ラ 1: Hosts 鍔寔
  hosts 鏂囦欢: server.self-serve.windsurf.com -> 127.0.0.1
  Windsurf IDE 鐨勬墍鏈夎姹傞兘杩炲埌鏈湴

姝ラ 2: 鏈湴 MITM 浠ｇ悊 (127.0.0.1:443)
  |- 鐢ㄨ嚜绛惧悕 CA 鍔ㄦ€佺鍙?server.self-serve.windsurf.com 璇佷功
  |- IDE 楠岃瘉璇佷功 -> CA 鍦ㄧ郴缁熶俊浠诲簱 -> 楠岃瘉閫氳繃
  |- 瑙ｅ瘑 HTTPS 璇锋眰鏄庢枃
  |- 娉ㄥ叆/闄勫姞鐢ㄦ埛鏍囪瘑锛坰k-ws-01-xxx锛屽弸鍟嗗彂缁欑敤鎴风殑 API Key锛?  +- 杞彂鍒伴€夊畾鐨勪唬鐞嗚妭鐐癸紙濡?windocker03.lgtc.top:443锛?
姝ラ 3: 浠ｇ悊鑺傜偣 (windocker03.lgtc.top)
  |- 鎺ユ敹璇锋眰锛屾彁鍙栫敤鎴?API Key锛坰k-ws-01-xxx锛?  |- 鍚?API 鏈嶅姟鍣紙win01.lgtc.top锛夐獙璇佺敤鎴疯韩浠?  |- 妫€鏌ョ敤鎴疯闃呯姸鎬併€佸墿浣欑Н鍒?  |- 浠庡彿姹犱腑閫夋嫨涓€涓彲鐢ㄧ殑 Windsurf 璇曠敤璐﹀彿
  |   +- 閫夊彿绛栫暐锛氭渶灏戜娇鐢紙Least-Used锛? 杞
  |- 瑙ｇ爜 Protobuf 璇锋眰浣?  |- 銆愬叧閿€戞浛鎹?protobuf 鍐呴儴鐨?API Key 瀛楁
  |   鍘熷: gsk-ws-01-[鐢ㄦ埛鐨刱ey] -> 鏇挎崲涓? gsk-[璇曠敤鍙风殑鐪熷疄key]
  |- 鏇挎崲/娉ㄥ叆 JWT Token 瀛楁锛堜娇鐢ㄨ瘯鐢ㄥ彿鐨?JWT锛?  |- 閲嶆柊缂栫爜 Protobuf + gzip 鍘嬬缉
  |- 杞彂鍒扮湡瀹?Windsurf 鍚庣 (server.self-serve.windsurf.com)
  +- 鎵ｉ櫎鐢ㄦ埛 1 绉垎

姝ラ 4: Windsurf 瀹樻柟鍚庣
  |- 鏀跺埌璇锋眰锛岀湅鍒扮殑鏄瘯鐢ㄥ彿鐨勮韩浠?  |- 姝ｅ父澶勭悊 Cascade 璇锋眰锛堣皟鐢?LLM锛?  +- 杩斿洖鍝嶅簲

姝ラ 5: 鍝嶅簲鍥炰紶
  Windsurf -> 浠ｇ悊鑺傜偣 -> 鏈湴 MITM 浠ｇ悊 -> 閲嶆柊鍔犲瘑 -> Windsurf IDE
  IDE 姝ｅ父鏄剧ず缁撴灉锛堝畬鍏ㄩ€忔槑锛?```

### 4.4 鍙屽眰 Key 浣撶郴

| 灞傜骇 | Key 鏍煎紡 | 鎸佹湁鑰?| 鐢ㄩ€?|
|------|----------|--------|------|
| **鐢ㄦ埛灞?* | `sk-ws-01-xxx` | 鍙嬪晢浠樿垂鐢ㄦ埛 | 璇嗗埆鐢ㄦ埛韬唤锛屽叧鑱旇闃呭拰绉垎 |
| **璐﹀彿姹犲眰** | `gsk-xxx` | Windsurf 璇曠敤鍙?| 鍚?Windsurf 瀹樻柟璁よ瘉锛屽疄闄呮秷鑰楄瘯鐢ㄧН鍒?|

鍙嬪晢浠ｇ悊鐨勬牳蹇冩搷浣滃氨鏄湪杩欎袱灞備箣闂村仛**閫忔槑妗ユ帴**锛?- 鐢ㄦ埛鍙湅鍒拌嚜宸辩殑 `sk-ws-01-xxx`
- Windsurf 鍙湅鍒拌瘯鐢ㄥ彿鐨?`gsk-xxx`
- 鐢ㄦ埛涓嶇煡閬撹嚜宸卞湪鐢ㄥ摢涓瘯鐢ㄥ彿锛學indsurf 涓嶇煡閬撹儗鍚庢槸澶氫汉鍏变韩

### 4.5 涓轰粈涔堝叏閮ㄨ姹傞兘鑳芥甯稿伐浣?
浠庨€氫俊鏃跺簭锛坅nalysis.md S9.10锛夊彲浠ョ湅鍒帮紝涓嶄粎 `GetChatMessage` 琚唬鐞嗭紝**鎵€鏈?Windsurf API 璋冪敤**閮界粡杩囦唬鐞嗚妭鐐癸細

| API 璋冪敤 | 浠ｇ悊澶勭悊 |
|----------|----------|
| `GetUserStatus` | 鏇挎崲 Key -> 杩斿洖璇曠敤鍙风殑璁㈤槄鐘舵€?|
| `GetUserJwt` | 鏇挎崲 Key -> 杩斿洖璇曠敤鍙风殑 JWT |
| `CheckUserMessageRateLimit` | 鏇挎崲 Key -> 杩斿洖璇曠敤鍙风殑绉垎闄愬埗 |
| `GetChatMessage` | 鏇挎崲 Key -> 杞彂 Cascade 瀵硅瘽璇锋眰 |
| `GetModelStatuses` | 鏇挎崲 Key -> 杩斿洖鍙敤妯″瀷鍒楄〃 |
| `Ping` | 閫忎紶 |

**鏁堟灉**锛歐indsurf IDE 璁や负鑷繁鐧诲綍鐨勬槸涓€涓湁鏁堢殑璇曠敤璐﹀彿锛屾墍鏈夊姛鑳芥甯稿伐浣溿€侷DE 鏄剧ず鐨勬槸璇曠敤鍙风殑鐘舵€侊紝鑰屽弸鍟嗙殑瀹㈡埛绔?UI锛坄:18921`锛夋樉绀虹敤鎴风湡姝ｇ殑璁㈤槄鐘舵€佸拰绉垎銆?
---

## 浜斻€佸鑺傜偣鏋舵瀯

### 5.1 鑺傜偣鍒楄〃

鏁版嵁鏉ユ簮锛歚GET http://127.0.0.1:18921/api/nodes`

| ID | 鍚嶇О | 鍩熷悕 | 绔彛 | 鍖哄煙 | 鐘舵€?|
|----|------|------|------|------|------|
| 1 | 骞夸笢2鍙?| `windocker02.lgtc.top` | 443 | 骞夸笢 | 鍦ㄧ嚎 |
| 2 | 骞夸笢3鍙?| `windocker03.lgtc.top` | 443 | 骞夸笢 | 鍦ㄧ嚎 |
| 5 | 骞夸笢4鍙?| `windocker04.lgtc.top` | 443 | 骞夸笢 | 鍦ㄧ嚎 |
| 6 | 娴嬭瘯鍙锋睜 | `windocker05.lgtc.top` | 443 | 涓滀含 | 鍦ㄧ嚎 |

> 娉細鑺傜偣 ID 浠?1 璺冲埌 5锛岃鏄庢湁鑺傜偣琚垹闄ゆ垨涓嬬嚎杩囷紙windocker01 鍙兘鏄棭鏈熻妭鐐癸級銆?
### 5.2 鑺傜偣閫夋嫨鏈哄埗

- 瀹㈡埛绔彁渚?*涓€閿帰娴嬮€夎矾**鍔熻兘锛坄/api/probe`锛夛紝骞跺彂 ping 鎵€鏈夎妭鐐?- 鐢ㄦ埛鍙墜鍔ㄥ垏鎹㈣妭鐐癸紙`/api/switch`锛?- 褰撳墠鐢ㄦ埛閫変腑鐨勮妭鐐逛俊鎭瓨鍌ㄥ湪 status 涓紙`last_node_id`, `last_node_ip`锛?- 鎺㈡祴鍙傛暟锛歚probe_count: 3`锛宍probe_interval: 300`锛堟瘡 5 鍒嗛挓涓€娆″績璺筹級

### 5.3 CDN 鏋舵瀯

鎵€鏈夎妭鐐瑰煙鍚嶏紙`windocker02-05.lgtc.top`锛夎В鏋愬埌鑵捐浜戝浗闄?CDN锛?
```
windocker0X.lgtc.top
  -> CNAME -> windocker0X.lgtc.top.cdn.dnsv1.com锛堣吘璁簯 CDN锛?  -> A 璁板綍锛氬涓吘璁簯 IP锛?3.xxx, 101.xxx锛?```

**浣滅敤**锛氶殣钘忕湡瀹炴湇鍔″櫒 IP銆丆DN 鎻愪緵 DDoS 闃叉姢銆佸氨杩戞帴鍏?
### 5.4 鏈嶅姟瑙掕壊鍒掑垎

| 鐢ㄩ€?| 鍩熷悕 | 鑱岃矗 |
|------|------|------|
| 鐢ㄦ埛绠＄悊 | `win01.lgtc.top` | 娉ㄥ唽/鐧诲綍/濂楅/婵€娲荤爜/鍏憡 |
| 浠ｇ悊鑺傜偣 | `windocker02-05.lgtc.top` | MITM 浠ｇ悊杞彂 + 鍙锋睜璋冨害 |

---

## 鍏€佸鎴风鎶€鏈垎鏋?
### 6.1 瀹㈡埛绔俊鎭?
| 灞炴€?| 鍊?|
|------|------|
| 鏂囦欢鍚?| `windsurf-LG_1.0.0.10.p.exe` |
| 澶у皬 | 16.28 MB |
| SHA256 | `B40F3124900006D589097A6B36B650AB673D0D551B6CCD9ED457724A60D6F81E` |
| 鐩戝惉绔彛 | `127.0.0.1:443`锛圡ITM 浠ｇ悊锛夛紝`127.0.0.1:18921`锛圵eb UI锛?|
| 鍐呭瓨鍗犵敤 | ~61.3 MB |
| 闇€瑕佹潈闄?| 绠＄悊鍛橈紙淇敼 hosts + 瀹夎 CA 璇佷功锛?|

### 6.2 鏈湴 Web UI

瀹㈡埛绔湪 `:18921` 绔彛鎻愪緵瀹屾暣 Web UI锛圵ind 瀹㈡埛绔級锛屽寘鍚細

| 椤甸潰 | 鍔熻兘 |
|------|------|
| 浠〃鐩?(`dashboard`) | 褰撳墠鐘舵€併€佷唬鐞嗛厤缃€佸叕鍛?|
| 鍙锋睜 (`nodes`) | 鑺傜偣鍒楄〃銆佹帰娴嬪欢杩熴€佸垏鎹㈣妭鐐?|
| 鎴戠殑璁㈤槄 (`my-plan`) | 绉垎鐢ㄩ噺銆佹仮澶嶅€掕鏃?|
| 鑾峰彇璁㈤槄 (`get-plan`) | 濂楅鍒楄〃銆佽喘涔?婵€娲?|
| 璇锋眰鏃ュ織 (`logs`) | 鍘嗗彶璇锋眰璁板綍锛堟椂闂?妯″瀷/鐘舵€侊級 |
| 璁剧疆 (`settings`) | 浠ｇ悊閰嶇疆銆佽瘉涔︾鐞?|

### 6.3 瀹㈡埛绔?API 绔偣

| 绔偣 | 鏂规硶 | 鐢ㄩ€?|
|------|------|------|
| `/api/status` | GET | 褰撳墠鐢ㄦ埛鐘舵€併€佷唬鐞嗙洰鏍囥€佺Н鍒?|
| `/api/plans` | GET | 鎵€鏈夊椁愬垪琛ㄥ拰浠锋牸 |
| `/api/nodes` | GET | 鑺傜偣鍒楄〃鍜屽湪绾跨姸鎬?|
| `/api/probe` | POST | 鎺㈡祴鑺傜偣寤惰繜 |
| `/api/switch` | POST | 鍒囨崲浠ｇ悊鑺傜偣 |
| `/api/logs` | GET | 璇锋眰鏃ュ織 |
| `/api/settings` | GET/POST | 浠ｇ悊璁剧疆 |
| `/api/cert/install` | POST | 瀹夎 MITM CA 璇佷功 |
| `/api/hosts/clean` | POST | 娓呯悊 hosts 鏂囦欢 |
| `/api/initialize` | POST | 鍒濆鍖栦唬鐞嗭紙淇敼 hosts锛?|
| `/api/restore` | POST | 杩樺師鍒濆鍖?|
| `/api/proxy/start` | POST | 鍚姩浠ｇ悊 |
| `/api/proxy/stop` | POST | 鍋滄浠ｇ悊 |
| `/api/login` | POST | 鐢ㄦ埛鐧诲綍 |
| `/api/register` | POST | 鐢ㄦ埛娉ㄥ唽 |
| `/api/activate` | POST | 婵€娲荤爜鍏戞崲 |
| `/api/heartbeat` | POST | 蹇冭烦淇濇椿 |
| `/api/announcement` | GET | 绯荤粺鍏憡 |
| `/api/fallback_switch` | GET/POST | 鏁呴殰杞Щ鍒囨崲 |

---

## 涓冦€佸晢涓氭ā寮忓垎鏋?
### 7.1 鎴愭湰缁撴瀯

| 鎴愭湰椤?| 浼扮畻 | 璇存槑 |
|--------|------|------|
| 鏈嶅姟鍣?| 楼200-500/鏈?| 4 涓唬鐞嗚妭鐐?+ 1 涓?API 鏈嶅姟鍣紝鑵捐浜?|
| CDN | 楼50-200/鏈?| 鑵捐浜戝浗闄?CDN 娴侀噺璐?|
| 鍩熷悕 | 楼10-30/骞?| `lgtc.top` |
| 璐﹀彿娉ㄥ唽 | ~楼0 | 鍏嶈垂璇曠敤鍙凤紝鏃犱俊鐢ㄥ崱鎴愭湰 |
| CAPTCHA 鐮磋В | 楼50-200/鏈?| CapSolver 绛夋湇鍔★紙濡傛湁 Turnstile锛?|
| QQ 閭/鍩熷悕閭 | 楼0-50/鏈?| catch-all 鍩熷悕鎴?QQ 閭璧勬簮 |
| **鏈堟€绘垚鏈?* | **楼300-1000** | |

### 7.2 鏀跺叆浼扮畻

鍋囪 50 涓椿璺冧粯璐圭敤鎴凤紝娣峰悎浣跨敤鍖呮椂/鍖呴噺锛?
| 鍦烘櫙 | 鐢ㄦ埛鏁?| 鏈堝潎娑堣垂 | 鏈堟敹鍏?|
|------|--------|----------|--------|
| 鍖呮椂鍩虹鐗?| 20 | 楼9.9x20澶?楼198 | 楼3,960 |
| 鍖呮椂涓撲笟鐗?| 15 | 楼15.88x20澶?楼318 | 楼4,770 |
| 鍖呮椂鏃楄埌鐗?| 5 | 楼25x20澶?楼500 | 楼2,500 |
| 鍖呴噺濂楅 | 10 | 楼40锛堜竴娆℃€э級 | 楼400 |
| **鍚堣** | **50** | | **~楼11,630/鏈?* |

### 7.3 鍒╂鼎鐜囷紙淇锛氬彇鍐充簬鍙锋簮锛?
鎸夆€滃弸鍟嗙Н鍒嗏増Windsurf credits鈥濆彛寰勶紝鍒╂鼎鐜囦笉鍐嶆槸鍥哄畾 90%+锛岃€屾槸寮轰緷璧栧彿婧愭垚鏈細

- **澶栭噰 Outlook 鍦烘櫙**锛埪?.2/鍙凤級锛?  - 鑻ョ敤鎴蜂竴澶╂秷鑰?3000 credits锛堝熀纭€鐗?15h 閲嶅害浣跨敤锛夛紝闇€绾?30 涓瘯鐢ㄥ彿
  - 鍗曠敤鎴峰彿婧愭垚鏈害 楼6/澶╋紝瀵瑰簲 楼9.9/澶╁椁愭瘺鍒╃害 楼3.9锛堢害 39%锛?- **鑷缓鍩熷悕 + catch-all 鍦烘櫙**锛?  - 鍗曞彿杈归檯鎴愭湰鍙樉钁椾綆浜庡閲囬偖绠?  - 浣嗗彈鍩熷悕椋庢帶涓庤嚜鍔ㄥ寲绋冲畾鎬ч檺鍒讹紝宸ョ▼澶嶆潅搴︽洿楂?
缁撹锛氬弸鍟嗘瘺鍒╃巼鍙兘鍦?**30%~90%** 鍖洪棿娉㈠姩锛屼笉鍚屽彿婧愮瓥鐣ュ樊寮傛瀬澶с€?
### 7.4 璐﹀彿姹犳秷鑰椾及绠楋紙淇锛氭寜 credits 瀵规爣锛?
- 姣忎釜璇曠敤鍙凤細100 credits锛圵indsurf Pro Trial锛?- 鍩虹鐗堢敤鎴凤紙1000 绉垎/5h锛夎嫢鏃ユ椿 15h 涓旀瘡绐楀彛鐢ㄦ弧锛氱害 3000 credits/澶?- 瀵瑰簲鍗曠敤鎴锋瘡澶╅渶绾?30 涓瘯鐢ㄥ彿

50 涓椿璺冪敤鎴峰満鏅細
- **婊¤浇涓婇檺**锛?0 x 30 = **1500 涓瘯鐢ㄥ彿/澶?*
- **鐜板疄鍖洪棿**锛?0%~60% 璐熻浇锛夛細**600~900 涓瘯鐢ㄥ彿/澶?*
- 14 澶╂粴鍔ㄦ睜瑙勬ā锛?  - 婊¤浇绾?**2.1 涓囧彿**
  - 鐜板疄鍖洪棿绾?**0.8~1.3 涓囧彿**

---

## 鍏€佷笌鎴戜滑浜у搧鐨勬繁搴︽妧鏈姣?
### 8.1 鎴戜滑鐨勫弻妯″紡鏋舵瀯

鎴戜滑鐨勪骇鍝佸疄闄呮敮鎸?*涓ょ杩愯妯″紡**锛屽弸鍟嗗彧鏈変竴绉嶏細

**妯″紡 A锛歄penAI-compatible API锛堥浂 MITM锛?*
```
鐢ㄦ埛鐨?AI 瀹㈡埛绔紙OpenClaw / 鍏朵粬锛?    |  鏍囧噯 OpenAI 鏍煎紡璇锋眰
    |  Authorization: Bearer sk-gw-xxx
    v
鎴戜滑鐨勭綉鍏?lab-server.js (:18790)
    |  /v1/chat/completions 绔偣
    |  璁よ瘉 -> 閫夊彿 -> 鍗忚杞崲 -> 杞彂
    v
Windsurf 瀹樻柟鍚庣 / 涓婃父 API
```
- **涓嶉渶瑕?*鏀?hosts銆佽璇佷功銆佺鐞嗗憳鏉冮檺
- 鐢ㄦ埛鍙紶 LLM 璇锋眰锛屼笉鏆撮湶宸ヤ綔鍖?
**妯″紡 B锛歐indsurf MITM 浠ｇ悊锛堝拰鍙嬪晢鐩稿悓鏂规锛?*
```
Windsurf IDE
    |  HTTPS 璇锋眰鍒?server.self-serve.windsurf.com
    |  琚?hosts 鍔寔鍒?127.0.0.1
    v
local-proxy.js (127.0.0.1:443)
    |  MITM 瑙ｅ瘑 -> 娉ㄥ叆鐢ㄦ埛鏍囪瘑
    |  杞彂鍒扮綉鍏?    v
lab-server.js (:18790)
    |  /exa.* 璺緞锛圕onnect Protocol锛?    |  replaceConnectCredentials() 鏇挎崲 protobuf 鍐?API Key + JWT
    |  閫夊彿 -> 杞彂鍒扮湡瀹?Windsurf
    v
Windsurf 瀹樻柟鍚庣
```
- 鍜屽弸鍟嗘妧鏈柟妗?*瀹屽叏涓€鑷?*
- 鍚屾牱瀹炵幇浜?Protobuf 绾?API Key 鏇挎崲锛坄connect-proto.js` 涓殑 `replaceConnectCredentials()`锛?- 鍚屾牱闇€瑕佹敼 hosts + 瑁?MITM CA 璇佷功

### 8.2 鍙锋睜-鐢ㄦ埛杩炴帴鏂规瀵规瘮

| 缁村害 | 鍙嬪晢 | 鎴戜滑 |
|------|------|------|
| **鏍稿績鏈哄埗** | Protobuf 鍐?API Key 鏇挎崲 | 鍚岋紙`replaceConnectCredentials()`锛?|
| **浼氳瘽浜插拰** | 鏈煡 | **Session Affinity**锛氬悓涓€ IP 缁戝畾鍚屼竴璇曠敤鍙?30 鍒嗛挓锛屾渶澶?4 鐢ㄦ埛/鍙?|
| **閫夊彿绛栫暐** | 鏈煡锛堟帹娴嬫渶灏戜娇鐢級 | 鏈€灏戜娇鐢?+ 浜插拰鎰熺煡璐熻浇鍧囪　锛坄getAffinitySession()`锛?|
| **Token 鍒锋柊** | 鏈煡 | Firebase Token 鑷姩鍒锋柊锛堟瘡 45 鍒嗛挓锛宍refreshFirebaseToken()`锛?|
| **鍙屽眰 Key** | `sk-ws-01-xxx` -> `gsk-xxx` | 鍚岋紙鐢ㄦ埛 Bearer Token -> session.sessionToken锛?|

**Session Affinity 鐨勪紭鍔?*锛氬弸鍟嗘瘡娆¤姹傚彲鑳藉垎閰嶄笉鍚岀殑璇曠敤鍙凤紝瀵艰嚧 Windsurf IDE 鐨勪笂涓嬫枃锛堝璇濆巻鍙层€侀」鐩姸鎬侊級鍦ㄤ笉鍚岃处鍙烽棿鍒囨崲銆傛垜浠殑浜插拰鏈哄埗纭繚鍚屼竴鐢ㄦ埛鍦?30 鍒嗛挓鍐呯粦瀹氬悓涓€璇曠敤鍙凤紝淇濇寔涓婁笅鏂囪繛缁€с€?
### 8.3 鎬讳綋鏋舵瀯瀵规瘮

| 缁村害 | 鍙嬪晢锛圵ind 瀹㈡埛绔級 | 鎴戜滑锛坈yber-drill-safe锛?|
|------|---------------------|------------------------|
| **浠ｇ悊妯″紡** | MITM 鍞竴妯″紡 | **鍙屾ā寮?*锛歄penAI API + MITM 浠ｇ悊 |
| **闇€瑕佺鐞嗗憳鏉冮檺** | 鏄紙鎵€鏈夌敤鎴凤級 | API 妯″紡涓嶉渶瑕侊紱MITM 妯″紡闇€瑕?|
| **瀹夊叏椋庨櫓** | 楂橈紙鍏ㄩ儴 HTTPS 娴侀噺鍙瑙ｅ瘑锛?| API 妯″紡浣庯紱MITM 妯″紡鍚屽弸鍟?|
| **瀹㈡埛绔?* | Windows EXE锛圙o 缂栧啓锛?| Electron 妗岄潰搴旂敤锛圧eact + TailwindCSS锛?|
| **绉垎璁¤垂** | 鎸?credits 鎵ｅ噺锛堝鏍?Windsurf锛岄潪鍥哄畾姣忔 1 鍒嗭級 | 鍙屾ā寮忥細DB 璁よ瘉鎸夎姹傛墸1锛屾枃浠惰璇佹寜 token 浼扮畻鎵?|
| **濂楅鏁伴噺** | 7 涓紙4鍖呴噺+3鍖呮椂锛?| 4 涓紙鍏嶈垂+3鍖呮椂锛?|
| **鑺傜偣鏁?* | 4 涓唬鐞嗚妭鐐?| 1 涓綉鍏筹紙棣欐腐 ECS 47.84.31.126锛?|
| **CDN** | 鑵捐浜戝浗闄?CDN | 鐩磋繛 |
| **璐﹀彿娉ㄥ唽** | QQ 閭鎵归噺娉ㄥ唽 | catch-all 鍩熷悕 + Cloudflare 閭欢璺敱 + Turnstile 鑷姩鐮磋В |
| **璐﹀彿绠＄悊** | 鏈煡锛堟湇鍔＄涓嶅彲瑙侊級 | 鍏ㄨ嚜鍔ㄧ敓鍛藉懆鏈熺鐞?|
| **浼氳瘽浜插拰** | 鏈煡 | 30 鍒嗛挓 TTL锛宮ax 4 鐢ㄦ埛/鍙?|
| **Token 鍒锋柊** | 鏈煡 | Firebase 鑷姩鍒锋柊锛?5 鍒嗛挓锛?|
| **瀹夊叏瀹¤** | 鏈煡 | 鎻愮ず璇嶆敞鍏ユ娴?+ 鏁忔劅淇℃伅鎺㈡祴 |
| **甯﹀鐩戞帶** | 鏈煡 | 瀹炴椂娴佺晠搴﹁瘎鍒嗭紙寤惰繜/閿欒鐜?骞跺彂锛?|

### 8.4 缃戝叧鍔熻兘瀵规瘮锛堟垜浠?lab-server.js 鐨勭嫭鏈夊姛鑳斤級

鍙嬪晢鐨勪唬鐞嗚妭鐐瑰姛鑳戒笉鍙锛屼絾浠?API 鍜岃涓烘帹娴嬶紝浠ヤ笅鏄垜浠凡瀹炵幇浣嗗弸鍟?*鏈繀鏈?*鐨勫姛鑳斤細

| 鍔熻兘 | 浠ｇ爜浣嶇疆 | 璇存槑 |
|------|----------|------|
| **Session Affinity** | `getAffinitySession()` L219-275 | 鍚?IP 缁戝畾鍚屼竴璇曠敤鍙凤紝闃蹭笂涓嬫枃鍒囨崲 |
| **Firebase Token 鑷姩鍒锋柊** | `refreshFirebaseToken()` L142-191 | 姣?45 鍒嗛挓鑷姩鍒锋柊锛屽欢闀?session 瀵垮懡 |
| **甯﹀/娴佺晠搴﹀疄鏃剁洃鎺?* | `getBandwidthMetrics()` L329-399 | RPM銆佸欢杩?P95銆佸苟鍙戞暟銆佹祦鐣呭害璇勫垎 |
| **鎻愮ず璇嶆敞鍏ユ娴?* | `detectTags()` L589-601 | 妫€娴?jailbreak / 瓒婄嫳 / API key 娉勯湶 |
| **璐﹀彿鍋ュ悍鑷姩鎽橀櫎/鎭㈠** | `checkAccountHealth()` L659-700 | 杩炵画 3 娆″け璐ユ憳闄わ紝2 娆℃垚鍔熸仮澶?|
| **Session 蹇冭烦淇濇椿** | `SessionManager.keepaliveHandler` L113-121 | 5 鍒嗛挓蹇冭烦锛岄槻姝?Windsurf session 杩囨湡 |
| **鍗忚閫傞厤鍣ㄦ彃浠跺寲** | `getAdapter(platform)` | 澶氬钩鍙版敮鎸佸氨缁紙涓嶅彧 Windsurf锛?|
| **鍙岃璇佹簮** | DB auth + 鏂囦欢 UserManager | 鏁版嵁搴撹璇佸拰鏂囦欢璁よ瘉骞跺瓨锛岀伒娲?|
| **绉垎鑷姪鏌ヨ API** | `/v1/credits` L1157-1208 | 鐢ㄦ埛鍙€氳繃 API 瀹炴椂鏌ヨ绉垎鐘舵€?|
| **妯″瀷鍒楄〃 API** | `/v1/models` L1129-1153 | 鏍囧噯 OpenAI /v1/models 鍏煎 |
| **姣忔棩鑷姩閲嶇疆** | `scheduleDailyReset()` L893-918 | 鍗堝鑷姩閲嶇疆鐢ㄩ噺璁℃暟鍣?|

### 8.5 绉垎璁¤垂瀵规瘮锛堜慨璁級

| 缁村害 | 鍙嬪晢锛坈redits 瀵规爣锛?| 鎴戜滑锛堟贩鍚堟ā寮忥級 |
|------|----------------------|----------------|
| **鎵ｈ垂鍙ｅ緞** | 涓?Windsurf credits 鍚岄噺绾诧紙楂樻垚鏈ā鍨嬫墸寰楁洿蹇級 | DB 璺緞鎸夎姹傛墸1锛涙枃浠惰矾寰勬寜 token 浼扮畻鎵?|
| **DB 璁よ瘉璺緞** | 涓嶅彲瑙侊紙鎺ㄦ祴闈炲浐瀹?1 鍒嗭級 | `deductCredit(userId, 1)` -> 姣忚姹傛墸 1 绉垎 |
| **鏂囦欢璁よ瘉璺緞** | 涓嶅彲瑙?| `consumeCredits(userId, tokenEstimate)` -> 鎸?token 浼扮畻鎵?|
| **瀹㈡埛鐞嗚В搴?* | 涓?Windsurf 浣撻獙涓€鑷达紙浣欓鍙樺寲鍙В閲婏級 | 涓ゅ鍙ｅ緞骞跺瓨锛岃В閲婃垚鏈緝楂?|
| **鍏钩鎬?* | 鏇存帴杩戠湡瀹炴ā鍨嬫垚鏈?| DB 璺緞鍋忕矖绮掑害锛涙枃浠惰矾寰勬洿鍏钩 |
| **鎴愭湰鍙帶鎬?* | 寮猴紙璐垫ā鍨嬩細蹇€熻€楀敖鐢ㄦ埛浣欓锛?| DB 璺緞寮憋紱鏂囦欢璺緞杈冨己 |

> 娉細鎴戜滑鐨?DB 璁よ瘉璺緞锛坄deductCredit(userId, 1)`锛宭ab-server.js L1256锛夌洰鍓嶄粛鏄浐瀹氭瘡璇锋眰 1 鍒嗭紝涓庢湰娆′慨璁㈠悗鐨勫弸鍟嗙瓥鐣ュ凡涓嶄竴鑷淬€?
### 8.6 濂楅璁捐瀵规瘮

| 缁村害 | 鍙嬪晢 | 鎴戜滑 |
|------|------|------|
| 鍖呴噺濂楅 | 鏈夛紙4妗ｏ紝楼4.5-76锛?| 鏃?|
| 鍖呮椂濂楅 | 鎸夊ぉ璁¤垂锛埪?.9-25/澶╋級 | 鎸夊ぉ璁¤垂锛埪?.9-25/澶╋紝seed 鏁版嵁锛?|
| 鍏嶈垂濂楅 | 鏃?| 鏈夛紙24h鎭㈠锛?|
| 閫€娆炬斂绛?| 鎸夊墿浣欓€€ | 鏈璁?|
| 婵€娲荤爜 | 鏈?| 鏈夛紙`/api/activation/redeem`锛?|
| 浠ｇ悊鍟?鍒嗛攢 | 鏈煡 | 鏈夛紙`agents` + `agent_commissions` 琛級 |

### 8.7 璐﹀彿娉ㄥ唽鑷姩鍖栧姣?
| 缁村害 | 鍙嬪晢 | 鎴戜滑 |
|------|------|------|
| **閭鏉ユ簮** | QQ 閭锛?8浣嶉殢鏈哄瓧姣岪qq.com锛?| catch-all 鍩熷悕锛坵s*@chuangling.online锛?|
| **CAPTCHA 鐮磋В** | 鏈煡 | CapSolver锛圓ntiTurnstileTaskProxyLess锛夛紝3-6 绉?娆?|
| **娉ㄥ唽鑷姩鍖?* | 鏈煡锛堟帹娴?Puppeteer锛?| Puppeteer + Xvfb + fetch 鎷︽埅鍣?|
| **閭欢楠岃瘉** | 鏈煡 | IMAP 鑷姩璇诲彇锛圦Q 閭 + ImprovMX 杞彂锛?|
| **鎵归噺娉ㄥ唽** | 鏈煡 | `scripts/windsurf-registrar.js`锛屾敮鎸佸苟琛?|
| **鍩熷悕鎵╁睍** | 鏈煡 | 鑷姩璐拱鍩熷悕 + Cloudflare 閭欢璺敱閰嶇疆 |
| **璐﹀彿鍚屾** | 鏈煡 | 娉ㄥ唽鍚庤嚜鍔ㄥ悓姝ュ埌鏈嶅姟鍣ㄥ彿姹?|
| **Cron 瀹氭椂** | 鏈煡 | 姣忓ぉ 8 鎵?x 5 涓?= 40 鏂拌处鍙?|
| **鍋ュ悍妫€鏌?* | 鏈煡 | 姣?4 灏忔椂鑷姩杩愯 |
| **涓嶈冻琛ュ厖** | 鏈煡 | 璐﹀彿浣庝簬闃堝€兼椂鑷姩绱ф€ユ敞鍐?|

---

## 涔濄€佸鎴戜滑浜у搧鐨勫惎绀?
### 9.1 鍙€熼壌鐨勮璁?
1. **鍖呴噺濂楅**锛氬弸鍟嗙殑鍖呴噺濂楅鏄緢濂界殑琛ュ厖锛岄€傚悎杞诲害鐢ㄦ埛鎴栬瘯鐢ㄧ敤鎴枫€傚缓璁鍔?楼5-20 鐨勪竴娆℃€у寘閲忓椁愩€?
2. **鎸夊ぉ璁¤垂**锛氭瘮鎸夋湀鏇寸伒娲伙紝鐢ㄦ埛蹇冪悊璐熸媴鏇翠綆銆傛垜浠?seed 鏁版嵁宸叉敮鎸佹寜澶┿€?
3. **鍏ㄩ噺鎭㈠**锛氱Н鍒嗘仮澶嶆椂鐩存帴閲嶇疆鍒颁笂闄愶紝姣斿閲忔仮澶嶆洿绠€鍗曠洿瑙傘€?
4. **閫€娆炬満鍒?*锛氭寜鍓╀綑閫€娆鹃檷浣庤喘涔伴棬妲涳紝寤鸿鍙傝€冦€?
5. **澶氳妭鐐?+ 鑷姩閫夎矾**锛氬弸鍟嗘湁 4 鑺傜偣 + CDN锛屾垜浠彧鏈?1 涓洿杩炶妭鐐广€傚缓璁嚦灏戝鍔犲埌 2-3 涓€?
6. **Web UI 鐘舵€侀潰鏉?*锛氬弸鍟嗙殑 `:18921` Web UI 浣撻獙涓嶉敊锛岀Н鍒嗚繘搴︽潯銆佹仮澶嶅€掕鏃躲€佽姹傛棩蹇楅兘寰堝疄鐢ㄣ€?
### 9.2 鎴戜滑宸叉湁鐨勬妧鏈紭鍔?
1. **鍙屾ā寮忔灦鏋?*锛氭棦鏀寔闆?MITM 鐨?OpenAI API 鏂瑰紡锛堝畨鍏ㄥ崠鐐癸級锛屽張鏀寔 MITM 浠ｇ悊鏂瑰紡锛堝吋瀹?Windsurf IDE 鍘熺敓浣撻獙锛夈€傚弸鍟嗗彧鏈?MITM銆?
2. **Session Affinity**锛氫繚璇佸悓涓€鐢ㄦ埛鍦ㄤ竴娈垫椂闂村唴浣跨敤鍚屼竴璇曠敤鍙凤紝閬垮厤 Windsurf 涓婁笅鏂囧垏鎹㈠鑷寸殑鍔熻兘寮傚父銆傚弸鍟嗘槸鍚︽湁姝ゆ満鍒舵湭鐭ャ€?
3. **Firebase Token 鑷姩鍒锋柊**锛氬欢闀?session 瀵垮懡鍒拌繙瓒?1 灏忔椂锛堝師濮?Firebase token 60 鍒嗛挓杩囨湡锛夈€傝繖鍙兘鏄弸鍟嗚瘯鐢ㄥ彿"鎻愬墠澶辨晥"鐨勭棝鐐广€?
4. **鍏ㄩ摼璺处鍙疯嚜鍔ㄥ寲**锛氫粠鍩熷悕璐拱鍒版敞鍐屽埌鍚屾鍒板仴搴锋鏌ュ埌娓呯悊锛屽畬鍏ㄨ嚜鍔ㄣ€傛瘡澶╄嚜鍔ㄨˉ鍏?40 涓柊鍙凤紝涓嶈冻鏃剁揣鎬ユ墿灞曘€?
5. **瀹夊叏瀹¤**锛氭彁绀鸿瘝娉ㄥ叆妫€娴嬨€佹晱鎰熶俊鎭帰娴嬨€佹棤鏁?token 鐖嗙牬鍛婅銆傚弸鍟嗘湭鐭ャ€?
6. **瀹炴椂鐩戞帶**锛氬甫瀹姐€佸欢杩熴€佸苟鍙戙€佹祦鐣呭害璇勫垎锛岃繍缁村彲瑙傛祴鎬ц繙瓒呭弸鍟嗭紙鑷冲皯浠庡叾瀹㈡埛绔?API 鐪嬩笉鍒版绫绘暟鎹級銆?
7. **鍗忚閫傞厤鍣?*锛歚getAdapter(platform)` 璁捐浣挎垜浠彲浠ユ墿灞曞埌 Cursor銆丟itHub Copilot 绛夊叾浠栧钩鍙帮紝涓嶅彧闄?Windsurf銆?
### 9.3 闇€瑕佹敼杩涚殑鏂瑰悜

1. **澧炲姞鍖呴噺濂楅**锛氳鐩栬交搴︾敤鎴峰拰涓€娆℃€т娇鐢ㄥ満鏅?2. **澧炲姞澶氳妭鐐?*锛氳嚦灏戦儴缃?2-3 涓湴鍩熻妭鐐癸紝鎻愪緵鑷姩閫夎矾
3. **CDN 鎺ュ叆**锛氶殣钘忕湡瀹?IP锛屾彁楂樺畨鍏ㄦ€у拰鍙敤鎬?4. **瀹㈡埛绔綋楠?*锛氬畬鍠?Electron 瀹㈡埛绔殑 UI 鍔熻兘锛屽鏍囧弸鍟嗙殑 Web UI
5. **绉垎璁¤垂缁熶竴**锛氳€冭檻灏?DB 璁よ瘉鍜屾枃浠惰璇佺殑绉垎鎵ｉ櫎閫昏緫缁熶竴

---

## 闄勫綍 A锛氭暟鎹潵婧?
| 鏁版嵁 | 鏉ユ簮 | 鑾峰彇鏂瑰紡 |
|------|------|----------|
| 濂楅鍒楄〃 | `http://127.0.0.1:18921/api/plans` | 鏈湴 API 璋冪敤 |
| 鐢ㄦ埛鐘舵€?| `http://127.0.0.1:18921/api/status` | 鏈湴 API 璋冪敤 |
| 鑺傜偣鍒楄〃 | `http://127.0.0.1:18921/api/nodes` | 鏈湴 API 璋冪敤 |
| 璇锋眰鏃ュ織 | `http://127.0.0.1:18921/api/logs` | 鏈湴 API 璋冪敤 |
| 瀹㈡埛绔?UI | `http://127.0.0.1:18921` | 鏈湴 Web UI |
| 瀹㈡埛绔?JS | `http://127.0.0.1:18921/js/app.js` | 鏈湴闈欐€佽祫婧?|
| 鍗忚鍒嗘瀽 | `analysis.md` | 鎶撳寘 + Protobuf 瑙ｇ爜 |
| 瀹樻柟绉垎 | Windsurf 瀹樻柟鏂囨。 | 鍏紑鏂囨。 |
| 妯″瀷绉垎鍊嶇巼 | Flexprice 鍒嗘瀽鏂囩珷 | 鍏紑鏂囩珷 |

## 闄勫綍 B锛氬弸鍟?API 鍘熷鍝嶅簲

### B.1 `/api/plans` 鍝嶅簲

```json
{"code":0,"data":[
  {"name":"100_bl","display_name":"璇曠敤濂楅","type":"credits","duration_days":365,"price":4.5,"initial_credits":100,"max_credits":100,"recovery_interval":0,"recovery_amount":0},
  {"name":"500_bl","display_name":"鍩虹濂楅","type":"credits","duration_days":365,"price":21,"initial_credits":500,"max_credits":500,"recovery_interval":0,"recovery_amount":0},
  {"name":"1000_bl","display_name":"涓撲笟濂楅","type":"credits","duration_days":365,"price":40,"initial_credits":1000,"max_credits":1000,"recovery_interval":0,"recovery_amount":0},
  {"name":"2000_bl","display_name":"鏃楄埌鐗堝椁?,"type":"credits","duration_days":365,"price":76,"initial_credits":2000,"max_credits":2000,"recovery_interval":0,"recovery_amount":0},
  {"name":"basic","display_name":"鍩虹鐗?,"type":"time","duration_days":1,"price":9.9,"initial_credits":1000,"max_credits":1000,"recovery_interval":18000,"recovery_amount":1000},
  {"name":"pro","display_name":"涓撲笟鐗?,"type":"time","duration_days":1,"price":15.88,"initial_credits":1000,"max_credits":1000,"recovery_interval":10800,"recovery_amount":1000},
  {"name":"premium","display_name":"鏃楄埌鐗?,"type":"time","duration_days":1,"price":25,"initial_credits":1000,"max_credits":1000,"recovery_interval":3600,"recovery_amount":1000}
],"msg":"ok"}
```

### B.2 `/api/status` 鍝嶅簲

```json
{"code":0,"data":{
  "api_key":"sk-ws-01-0002o0L6OHZdCjuzgj8MaHUOAHOFz8OTOWxhjnf121wLprSxPlLQAz5M5OtEPWZ3KNeq1kOwQRjmVYXc7FRLF0XyqhQ",
  "cert_installed":true,
  "credits":0,"max_credits":0,
  "current_hosts":"127.0.0.1",
  "logged_in":true,
  "plan_name":"premium",
  "proxy_target":"windocker03.lgtc.top",
  "server_url":"https://win01.lgtc.top",
  "user_id":96,"username":"XUE",
  "last_node_id":2,"last_node_name":"骞夸笢3鍙?,
  "probe_count":3,"probe_interval":300
},"msg":"ok"}
```

### B.3 `/api/nodes` 鍝嶅簲

```json
{"code":0,"data":{
  "current_id":2,
  "current_ip":"windocker03.lgtc.top",
  "nodes":[
    {"id":1,"name":"骞夸笢2鍙?,"ip":"windocker02.lgtc.top","port":443,"region":"骞夸笢2鍙?,"online":true},
    {"id":2,"name":"骞夸笢3鍙?,"ip":"windocker03.lgtc.top","port":443,"region":"骞夸笢3鍙?,"online":true},
    {"id":5,"name":"骞夸笢4鍙?,"ip":"windocker04.lgtc.top","port":443,"region":"骞夸笢4鍙?,"online":true},
    {"id":6,"name":"娴嬭瘯鍙锋睜","ip":"windocker05.lgtc.top","port":443,"region":"鑺傜偣 涓滀含","online":true}
  ]
},"msg":"ok"}
```

---

## 附录 C：Credit 传递机制深度分析
> 分析日期：2026-02-28 | 数据来源：协议逆向 + MITM 抓包 + 友商客户端 API + Windsurf IDE 行为观察

### C.1 核心发现：双层 Credit 体系

友商产品运行着**两套完全独立的 credit 系统**，分别面向不同的"受众"：

```
┌─────────────────────────────────────────────────────────────┐
│  Layer A: Windsurf 原生 Credits（底层 - Trial 账号）          │
│  ─────────────────────────────────────────────────          │
│  持有者：号池中的 Trial 账号                                  │
│  总量：100 credits / 账号（Pro Trial）                       │
│  消耗：按 Windsurf 官方模型倍率                               │
│  查询：GetUserStatus / CheckUserMessageRateLimit             │
│  显示位置：Windsurf IDE 状态栏                                │
│  用户感知：用户在 IDE 里看到的 tier 和 credits                 │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  Layer B: 友商自有 Credits（用户层 - 付费积分）               │
│  ─────────────────────────────────────────────────          │
│  持有者：友商的付费用户                                       │
│  总量：1000 积分 / 套餐窗口                                  │
│  消耗：与 Windsurf credits 近似 1:1 映射                     │
│  恢复：按套餐级别自动恢复（1h/3h/5h/24h）                     │
│  查询：友商 /api/status                                     │
│  显示位置：友商客户端 Web UI (:18921)                         │
│  用户感知：用户在友商客户端看到的"我的积分"                     │
└─────────────────────────────────────────────────────────────┘
```

**两层 credit 是解耦的**——用户买的是 Layer B 的积分，消耗的是 Layer A 的 Trial credits。友商在中间做映射和调度。

### C.2 Credit 传递完整流程

```
用户在 IDE 发送一条 Cascade 消息
    │
    ├──① IDE 调 CheckUserMessageRateLimit ──→ 友商代理替换凭证 ──→ Windsurf 返回 Trial 账号剩余 credits
    │   └── IDE 判断：credits > 0？允许发送 : 显示限额提示
    │
    ├──② IDE 调 GetChatMessage ──→ 友商代理替换凭证 ──→ Windsurf 消耗 Trial 账号 credits ──→ 返回 AI 回复
    │   └── 友商节点同时扣减用户的 Layer B 积分（与 Windsurf credits 近似 1:1）
    │
    └──③ IDE 轮询 GetUserStatus（30秒内11次）──→ 友商代理替换凭证 ──→ 返回 Trial 账号的 tier/status
        └── IDE 状态栏更新：显示 "Pro Trial"，credits 数值随 Trial 账号变化
```

### C.3 抓包证据

**证据 1：CheckUserMessageRateLimit 响应**（来自 analysis.md S9.6）
```
field 1 (varint): 1      → 允许发送（1=yes）
field 3 (varint): 29     → Trial 账号剩余 credits
field 4 (varint): 30     → Trial 账号总 credits 上限
field 5 (varint): 3195   → 可能是重置倒计时（秒）
```
> IDE 收到的是 Trial 账号的 29/30 credits，不是用户购买的 1000 积分。

**证据 2：GetUserStatus 高频轮询**（来自 analysis.md S9.10）
```
30秒内 GetUserStatus 被调用 11 次：
  205004  GetUserStatus  405B / 5532B
  206115  GetUserStatus  404B / 5532B
  206444  GetUserStatus  156B / 5800B
  210618  GetUserStatus  404B / 5532B
  218966  CheckUserMessageRateLimit  1327B / 33B  ← 额度检查
  219776  GetUserStatus  404B / 5532B
  221781  GetChatMessage  25924B / 5262B  ← 用户对话
  222134  GetUserStatus  404B / 5532B
  232787  GetUserStatus  156B / 5800B
  233224  GetUserStatus  156B / 5800B
```
> IDE 在每次对话前后都检查 Trial 账号状态，确保 credits 足够。

**证据 3：友商 /api/status 返回**
```json
{
  "credits": 0,
  "max_credits": 0,
  "plan_name": "premium"
}
```
> premium 用户 credits=0 说明 Layer B 积分已用尽。但 IDE 侧可能仍能发消息（如果 Trial 账号还有 credits），这取决于友商是否在节点层做了额外拦截。

### C.4 友商的 Credit 传递策略分析

| 维度 | 友商做法 | 效果 |
|------|---------|------|
| **IDE 显示什么** | Trial 账号的 tier + credits | 用户看到 "Pro Trial"，credits 随使用减少 |
| **客户端显示什么** | 用户购买的积分 + 恢复倒计时 | 用户在 Web UI 管理自己的"真实"配额 |
| **两层冲突时** | Layer B 先耗尽 → 节点拒绝转发（推测） | 用户被友商限额，不管 Trial 有没有 credits |
| **Trial 耗尽时** | 轮换到新 Trial 账号 | IDE 的 GetUserStatus 自动刷新到新账号状态 |
| **用户感知** | IDE 的 credits 数字会"跳变"（换号时突然回满） | 用户可能困惑，但友商客户端的积分是平滑的 |

### C.5 友商方案的巧妙之处

1. **用户不需要理解 Windsurf credits**：用户只看友商客户端的积分（1000 积分 + 恢复），IDE 里的 credits 数字是"附带的"
2. **Trial 账号轮换对用户透明**：换号时 IDE 的 credits 数字跳变，但用户的"真实积分"（客户端显示）是连续的
3. **成本控制内置于积分映射**：友商积分 ≈ Windsurf credits（1:1），贵模型（Opus ~20 credits/次）自然消耗更快
4. **恢复机制是成本阀门**：5h/3h/1h 恢复间隔控制了单位时间的 Trial 账号消耗速率

### C.6 我们的架构对比 & 发现的 BUG

**我们的 credit 传递路径：**
```
用户 IDE ──→ local-proxy.js (本地) ──→ lab-server.js (ECS)
                                          │
                                          ├─ 选号 (getAffinitySession)
                                          ├─ 替换凭证 (replaceConnectCredentials)
                                          └─ 转发到 Windsurf
```

**2026-02-28 发现的 BUG：**

`replaceConnectCredentials()` 只能处理 Connect frame 格式（5字节头 + payload），但 `GetUserStatus` 请求使用**裸 protobuf**格式（无帧头）。

| 请求类型 | 请求格式 | Content-Type | 凭证替换 |
|---------|---------|-------------|---------|
| `GetChatMessage` | Connect frame（`0x01` 开头） | `application/connect+proto` | ✓ 成功 |
| `GetUserStatus` | 裸 protobuf（`0x0a` 开头） | `application/proto` | ✗ **失败** |
| `CheckUserMessageRateLimit` | Connect frame | `application/connect+proto` | ✓ 成功 |

**影响**：用户 IDE 看到的是**自己的账号状态**（Free/过期），而不是 Trial 池子的。GetChatMessage 正常工作（用的是 Trial 账号），但 IDE 状态栏显示不一致。

**已修复**：`replaceConnectCredentials()` 增加了格式自动检测，同时支持 Connect frame 和裸 protobuf。修复后所有 `/exa.*` 端点的凭证替换均正常。

### C.7 我们应该如何实现 Credit 传递

基于友商分析，推荐我们也采用**双层 credit 体系**：

```
┌────────────────────────────────────────────────────┐
│  底层（自动）：Trial 账号 credits 追踪              │
│  - credit-tracker.js 在代理中拦截 GetChatMessage    │
│  - 按模型倍率扣减内存缓存，定期同步到 DB             │
│  - Trial 账号 credits 耗尽时自动轮换                 │
│  - real-credits.js 可直连 Windsurf API 校准          │
└────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────┐
│  用户层（面向客户）：自有积分系统                     │
│  - 用户购买套餐获得积分（如 1000 积分 / 5h 恢复）    │
│  - 每次请求按 Windsurf credits 消耗量扣减用户积分    │
│  - /v1/credits API 供客户端查询                     │
│  - 积分 ≤ 0 时拒绝转发（不管 Trial 有没有 credits） │
└────────────────────────────────────────────────────┘
```

**当前进度：**
- [x] `replaceConnectCredentials` 修复（支持裸 protobuf）
- [x] `credit-tracker.js` 模块（底层 Trial credits 追踪）
- [x] `real-credits.js` 直连 API 查询真实 credits（已验证可用）
- [x] `scripts/credits.js` CLI 查询工具
- [x] `database.js` 支持 `credits_remaining` 字段
- [ ] 用户层积分扣减逻辑（`deductCredit` 按 Windsurf credits 映射）
- [ ] Trial 账号 credits 耗尽时自动轮换逻辑
- [ ] Electron 客户端积分显示 UI

