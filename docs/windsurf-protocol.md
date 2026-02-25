# Windsurf/Codeium Protocol Analysis

> Reverse-engineered from MITM capture on 2026-02-25

## Transport

| Property | Value |
|----------|-------|
| Protocol | Connect Protocol v1 (connectrpc.com) |
| Serialization | Protobuf |
| Compression | gzip (`connect-content-encoding: gzip`) |
| Domain | `server.self-serve.windsurf.com` |
| Server IP | `34.49.14.144` (Google Cloud) |
| User-Agent | `connect-go/1.18.1 (go1.25.5)` |
| Streaming | Server-side streaming (multiple envelopes) |

## Connect Protocol Envelope

Each message is wrapped in a 5-byte envelope:

```
[flags: 1 byte] [length: 4 bytes big-endian] [payload: N bytes]
```

- `flags & 0x01` = compressed (gzip)
- `flags & 0x02` = end-of-stream (trailers)
- `flags = 0x03` = compressed + end-of-stream

## Endpoints

### Core AI

| Endpoint | Purpose |
|----------|---------|
| `/exa.api_server_pb.ApiServerService/GetChatMessage` | **AI chat completion (streaming)** |
| `/exa.api_server_pb.ApiServerService/CheckUserMessageRateLimit` | Rate limit check before sending |
| `/exa.api_server_pb.ApiServerService/GetCommandModelConfigs` | Available model configurations |
| `/exa.api_server_pb.ApiServerService/GetModelStatuses` | Model availability status |

### Auth & User

| Endpoint | Purpose |
|----------|---------|
| `/exa.auth_pb.AuthService/GetUserJwt` | Get JWT token |
| `/exa.seat_management_pb.SeatManagementService/GetUserStatus` | User status / quota |
| `/exa.seat_management_pb.SeatManagementService/GetProfileData` | User profile |

### Telemetry (can be stubbed)

| Endpoint | Purpose |
|----------|---------|
| `/exa.analytics_pb.AnalyticsService/RecordCortexTrajectoryStep` | Trajectory tracking |
| `/exa.api_server_pb.ApiServerService/RecordAsyncTelemetry` | Async telemetry |
| `/exa.api_server_pb.ApiServerService/RecordGitTelemetry` | Git telemetry |
| `/exa.api_server_pb.ApiServerService/RecordCortexGeneratorMetadata` | Generator metadata |
| `/exa.api_server_pb.ApiServerService/RecordCortexExecutionMetadata` | Execution metadata |
| `/exa.api_server_pb.ApiServerService/RecordTrajectorySegmentAnalytics` | Segment analytics |
| `/exa.product_analytics_pb.ProductAnalyticsService/RecordAnalyticsEvent` | Product analytics |
| `/exa.api_server_pb.ApiServerService/Ping` | Heartbeat |

---

## GetChatMessage Request

**Content-Type:** `application/connect+proto`

### Protobuf Schema (inferred)

```protobuf
// Field numbers from capture analysis

message GetChatMessageRequest {
  ClientMetadata metadata = 1;
  SessionInfo session = 2;
  repeated ChatMessage messages = 3;        // conversation history
  int32 unknown_7 = 7;                      // observed: 5
  ModelConfig model_config = 8;
  ExperimentConfig experiments = 9;
  repeated ToolDefinition tools = 10;       // available tools
  ThinkingMode thinking_mode = 12;
  UnknownConfig config_13 = 13;
  ConversationInfo conversation = 15;
  string trajectory_id = 16;               // UUID
  int32 unknown_20 = 20;                    // observed: 1
  string model_name = 21;                  // e.g. "MODEL_SWE_1_5_SLOW"
  string session_id = 22;                  // UUID
}

message ClientMetadata {
  string editor_name = 1;                  // "windsurf"
  string editor_version = 2;              // "1.48.2"
  string api_key = 3;                     // "sk-ws-01-..."
  string locale = 4;                      // "en"
  string os_info = 5;                     // JSON or "windows"
  string ls_version = 7;                  // "1.9544.28"
  string hardware_info = 8;              // JSON (CPU, memory)
  int32 request_counter = 9;             // incrementing
  string machine_id = 10;                // UUID
  string product = 12;                    // "windsurf"
  Timestamp request_time = 16;
  string extensions_path = 17;            // filesystem path
  string jwt_token = 21;                  // base64 JWT
  string hash_24 = 24;                    // hex hash
  string tier = 26;                       // "Free" / "Unset"
  bytes flags = 30;
}

message ChatMessage {
  int32 role = 2;                         // 1 = system/context, varies
  oneof content {
    bytes raw_content = 3;                // for system prompts (bytes)
    string text_content = 3;              // for user messages (string)
  }
  int32 token_count = 4;
  int32 is_user = 5;                      // 1 = user message
  MessageMeta meta = 8;
}

message ModelConfig {
  int32 unknown_1 = 1;                    // 1
  int32 max_tokens = 2;                   // 8192
  int32 unknown_3 = 3;                    // 200
  double temperature = 5;                 // IEEE 754
  double top_p = 6;                       // IEEE 754
  int32 unknown_7 = 7;                    // 50
  double presence_penalty = 8;            // IEEE 754
  repeated string stop_sequences = 9;     // "
