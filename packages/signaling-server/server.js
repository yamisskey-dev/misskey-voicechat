const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

const PORT = 3000;

console.log('--- Signaling Server ---');

// --- VoiceCallServiceクラス（シグナリングロジックの本体） ---
class VoiceCallService {
    constructor() {
        this.workerConnections = [];
        this.pendingRequests = new Map();
        this.rooms = new Map();
        this.peers = new Map();
        this.connectToWorker();
    }

    connectToWorker() {
        const workerServerUrl = process.env.MEDIASOUP_WORKER_URL || 'ws://localhost:4000';
        const ws = new WebSocket(workerServerUrl);

        ws.on('open', () => {
            console.log(`Connected to Mediasoup Worker at ${workerServerUrl}`);
            this.workerConnections.push(ws);
        });

        ws.on('message', (message) => {
            const msg = JSON.parse(message.toString());
            const { type, requestId, payload } = msg;
            if (this.pendingRequests.has(requestId)) {
                if (type === 'success') {
                    this.pendingRequests.get(requestId).resolve(payload);
                } else if (type === 'error') {
                    this.pendingRequests.get(requestId).reject(new Error(payload.message));
                }
                this.pendingRequests.delete(requestId);
            }
        });

        ws.on('close', () => {
            console.log('Disconnected from Mediasoup Worker. Reconnecting in 5 seconds...');
            this.workerConnections = [];
            setTimeout(() => this.connectToWorker(), 5000);
        });

        ws.on('error', (err) => {
            console.error('WebSocket error with Mediasoup Worker:', err.message);
        });
    }

    // Workerにリクエストを送り、応答をPromiseで待つヘルパー
    _requestWorker(type, payload) {
        const workerWs = this.workerConnections[0];
        if (!workerWs) return Promise.reject(new Error('No available mediasoup worker'));

        const requestId = uuidv4();
        const request = { type, payload, requestId };

        return new Promise((resolve, reject) => {
            this.pendingRequests.set(requestId, { resolve, reject });
            workerWs.send(JSON.stringify(request));
            setTimeout(() => {
                if (this.pendingRequests.has(requestId)) {
                    reject(new Error(`Request ${requestId} timed out`));
                    this.pendingRequests.delete(requestId);
                }
            }, 5000); // 5秒のタイムアウト
        });
    }
    
    // 特定のクライアントにメッセージを送信
    _send(client, type, payload) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'voice-call', body: { type, payload } }));
        }
    }
    
    // ルーム内の指定したクライアント以外にブロードキャスト
    _broadcast(room, excludeClientId, type, payload) {
        for (const peer of room.peers.values()) {
            if (peer.id !== excludeClientId) {
                this._send(peer.client, type, payload);
            }
        }
    }

    // クライアントからのWebSocket接続を処理
    handleNewPeer(client, userId) {
        console.log(`Peer connected: ${userId}`);
        this.peers.set(client, { id: userId });
    }

    // クライアントの切断を処理
    handlePeerDisconnect(client) {
        const peerInfo = this.peers.get(client);
        if (!peerInfo) return;
        
        console.log(`Peer disconnected: ${peerInfo.id}`);
        // ルームからピアを退出させるなどのクリーンアップ処理
        for (const room of this.rooms.values()) {
            const peerInRoom = room.peers.get(peerInfo.id);
            if (peerInRoom) {
                peerInRoom.producers.forEach(producer => {
                    this._broadcast(room, peerInfo.id, 'producerClosed', { producerId: producer.id });
                });
                room.peers.delete(peerInfo.id);
            }
        }
        this.peers.delete(client);
    }
    
    // クライアントからのメッセージを処理
    async handleMessage(client, message) {
        const peerInfo = this.peers.get(client);
        if (!peerInfo) return;
        const peerId = peerInfo.id;

        const { type, payload } = message;

        try {
            switch (type) {
                case 'joinRoom': {
                    const { roomId } = payload;
                    let room = this.rooms.get(roomId);
                    if (!room) {
                        const routerInfo = await this._requestWorker('createRouter', {});
                        room = { id: roomId, routerId: routerInfo.id, peers: new Map() };
                        this.rooms.set(roomId, room);
                    }
                    
                    const existingProducers = [];
                    for (const otherPeer of room.peers.values()) {
                       otherPeer.producers.forEach(p => existingProducers.push({ producerId: p.id, peerId: otherPeer.id }));
                    }

                    room.peers.set(peerId, { id: peerId, client, transports: new Map(), producers: new Map(), consumers: new Map() });
                    this._send(client, 'joined', { existingProducers });
                    break;
                }

                case 'getRouterRtpCapabilities': {
                    const { roomId } = payload;
                    const room = this.rooms.get(roomId);
                    if (!room) throw new Error('Room not found');
                    const routerInfo = await this._requestWorker('getRouterInfo', { routerId: room.routerId }); // Worker側にこのAPIが必要になる
                    this._send(client, 'routerRtpCapabilities', routerInfo.rtpCapabilities);
                    break;
                }
                
                case 'createTransport': {
                    const { roomId } = payload;
                    const room = this.rooms.get(roomId);
                    const transportParams = await this._requestWorker('createWebRtcTransport', { routerId: room.routerId });
                    room.peers.get(peerId).transports.set(transportParams.id, {});
                    this._send(client, 'transportCreated', transportParams);
                    break;
                }

                case 'connectTransport':
                case 'produce':
                case 'consume':
                case 'resumeConsumer': {
                    const { roomId } = payload;
                    if (!this.rooms.has(roomId) || !this.rooms.get(roomId).peers.has(peerId)) {
                        throw new Error('You are not in this room');
                    }
                    const response = await this._requestWorker(type, payload);
                    if (type === 'produce') {
                        this.rooms.get(roomId).peers.get(peerId).producers.set(response.id, {});
                        this._broadcast(this.rooms.get(roomId), peerId, 'newProducer', { producerId: response.id, peerId });
                    } else {
                        this._send(client, type === 'consume' ? 'consumed' : `${type}d`, response);

                    }
                    break;
                }

                default:
                    throw new Error(`Unknown message type: ${type}`);
            }
        } catch (err) {
            console.error(`Error handling message from ${peerId}:`, err.message);
            this._send(client, 'error', { message: err.message });
        }
    }
}


// --- サーバーの起動 ---
const server = http.createServer();
const wss = new WebSocket.Server({ server });
const voiceCallService = new VoiceCallService();

wss.on('connection', (ws) => {
    // 実際のMisskey実装では、ここで認証を行いユーザーIDを特定する
    const tempUserId = `user-${uuidv4()}`;
    voiceCallService.handleNewPeer(ws, tempUserId);

    ws.on('message', (message) => {
        try {
            const msg = JSON.parse(message.toString());
            if (msg.type === 'voice-call' && msg.body) {
                voiceCallService.handleMessage(ws, msg.body);
            }
        } catch (e) {
            console.error('Invalid message received:', e);
        }
    });

    ws.on('close', () => {
        voiceCallService.handlePeerDisconnect(ws);
    });
});

server.listen(PORT, () => {
    console.log(`Signaling Server WebSocket endpoint is listening on port ${PORT}`);
});