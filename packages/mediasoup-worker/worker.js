const WebSocket = require('ws');
const mediasoup = require('mediasoup');

const PORT = 4000;

console.log('--- Mediasoup Worker Server ---');

// --- 環境変数から設定を読み込む ---
// Docker Composeから渡される。ローカルデバッグ用のデフォルト値も設定。
const ANNOUNCED_IP = process.env.MEDIASOUP_ANNOUNCED_IP || '127.0.0.1';
const TURN_URL = process.env.TURN_SERVER_URL; // 例: 'turn_server:3478'
const TURN_USER = process.env.TURN_SERVER_USER; // 例: 'misskey'
const TURN_PASS = process.env.TURN_SERVER_PASS; // 例: 'turnpassword'

// --- グローバル変数 ---
let worker;
const routers = new Map();
const transports = new Map();
const producers = new Map();
const consumers = new Map();

// --- Mediasoup Workerの初期化 ---
async function startMediasoup() {
    try {
        worker = await mediasoup.createWorker({
            logLevel: 'warn',
            rtcMinPort: 40000, // ポート範囲をDocker側と一致させる
            rtcMaxPort: 40010,
        });

        worker.on('died', () => {
            console.error(`mediasoup worker process ${worker.pid} died, exiting...`);
            process.exit(1);
        });

        console.log(`Mediasoup worker process created [pid:${worker.pid}]`);
    } catch (err) {
        console.error('Failed to create mediasoup worker:', err);
        process.exit(1);
    }
}

startMediasoup();

// --- WebSocketサーバーの起動 ---
const wss = new WebSocket.Server({ port: PORT });
console.log(`Listening for Signaling Server connections on port ${PORT}`);

// Signaling Serverからの接続を処理
wss.on('connection', ws => {
    console.log('Signaling Server connected.');

    ws.on('close', () => {
        console.log('Signaling Server disconnected.');
    });

    ws.on('error', (err) => {
        console.error('Connection error with Signaling Server:', err);
    });

    // Signaling Serverからの命令を処理
    ws.on('message', async message => {
        const msg = JSON.parse(message);
        const { type, payload, requestId } = msg;

        try {
            let responsePayload;

            switch (type) {
                case 'createRouter': {
                    const router = await worker.createRouter({
                        mediaCodecs: [
                            { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 }
                        ],
                    });
                    routers.set(router.id, router);
                    responsePayload = { id: router.id, rtpCapabilities: router.rtpCapabilities };
                    break;
                }
                
                case 'createWebRtcTransport': {
                    const { routerId } = payload;
                    const router = routers.get(routerId);
                    if (!router) throw new Error(`Router with id "${routerId}" not found`);

                    const transport = await router.createWebRtcTransport({
                        listenIps: [{ ip: '0.0.0.0', announcedIp: ANNOUNCED_IP }],
                        enableUdp: true,
                        enableTcp: true,
                        preferUdp: true,
                        turnServers: [
                            {
                                urls: `turn:${TURN_URL}`,
                                username: TURN_USER,
                                credential: TURN_PASS,
                            }
                        ]
                    });
                    transports.set(transport.id, transport);
                    responsePayload = {
                        id: transport.id,
                        iceParameters: transport.iceParameters,
                        iceCandidates: transport.iceCandidates,
                        dtlsParameters: transport.dtlsParameters,
                    };
                    break;
                }

                case 'connectTransport': {
                    const { transportId, dtlsParameters } = payload;
                    const transport = transports.get(transportId);
                    if (!transport) throw new Error(`Transport with id "${transportId}" not found`);
                    await transport.connect({ dtlsParameters });
                    responsePayload = { connected: true };
                    break;
                }

                case 'produce': {
                    const { transportId, kind, rtpParameters } = payload;
                    const transport = transports.get(transportId);
                    if (!transport) throw new Error(`Transport with id "${transportId}" not found`);
                    
                    const producer = await transport.produce({ kind, rtpParameters });
                    producers.set(producer.id, producer);
                    responsePayload = { id: producer.id };
                    break;
                }

                case 'consume': {
                    const { routerId, transportId, producerId, rtpCapabilities } = payload;
                    const router = routers.get(routerId);
                    if (!router) throw new Error(`Router with id "${routerId}" not found`);
                    const transport = transports.get(transportId);
                    if (!transport) throw new Error(`Transport with id "${transportId}" not found`);
                    
                    if (!router.canConsume({ producerId, rtpCapabilities })) {
                        throw new Error('Cannot consume');
                    }
                    
                    const consumer = await transport.consume({ producerId, rtpCapabilities, paused: true });
                    consumers.set(consumer.id, consumer);
                    responsePayload = {
                        id: consumer.id,
                        producerId,
                        kind: consumer.kind,
                        rtpParameters: consumer.rtpParameters,
                    };
                    break;
                }
                
                case 'resumeConsumer': {
                    const { consumerId } = payload;
                    const consumer = consumers.get(consumerId);
                    if (!consumer) throw new Error(`Consumer with id "${consumerId}" not found`);
                    await consumer.resume();
                    responsePayload = { resumed: true };
                    break;
                }
                
                default:
                    throw new Error(`Unknown request type: ${type}`);
            }
            
            // 成功応答を返す
            ws.send(JSON.stringify({ type: 'success', requestId, payload: responsePayload }));

        } catch (err) {
            console.error(`Error processing request ${requestId} (${type}):`, err.message);
            // エラー応答を返す
            ws.send(JSON.stringify({ type: 'error', requestId, payload: { message: err.message } }));
        }
    });
});