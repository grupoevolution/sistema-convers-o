const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs').promises;
const app = express();

// ============ CONFIGURAÇÕES ============
const EVOLUTION_BASE_URL = process.env.EVOLUTION_BASE_URL || 'https://evo.flowzap.fun';
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || 'SUA_API_KEY_AQUI';
const PIX_TIMEOUT = 7 * 60 * 1000; // 7 minutos
const ACK_TIMEOUT_MS = parseInt(process.env.ACK_TIMEOUT_MS) || 10000; // 10 segundos
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'funnels.json');
const CONVERSATIONS_FILE = path.join(__dirname, 'data', 'conversations.json');

// Mapeamento dos produtos Kirvano
const PRODUCT_MAPPING = {
    '5c1f6390-8999-4740-b16f-51380e1097e4': 'CS',
    '0f393085-4960-4c71-9efe-faee8ba51d3f': 'CS',
    'e2282b4c-878c-4bcd-becb-1977dfd6d2b8': 'CS',
    '5288799c-d8e3-48ce-a91d-587814acdee5': 'FAB'
};

// Instâncias Evolution (fallback sequencial)
const INSTANCES = ['GABY01', 'GABY02', 'GABY03', 'GABY04', 'GABY05', 'GABY06', 'GABY07', 'GABY08', 'GABY09'];

// ============ ARMAZENAMENTO EM MEMÓRIA ============
let conversations = new Map();
let pendingAcks = new Map();
let idempotencyCache = new Map();
let stickyInstances = new Map();
let pixTimeouts = new Map();
let logs = [];
let funis = new Map();

// ============ FUNIS PADRÃO ============
const defaultFunnels = {
    'CS_APROVADA': {
        id: 'CS_APROVADA',
        name: 'CS - Compra Aprovada',
        steps: [
            {
                id: 'step_1',
                type: 'text',
                text: 'Parabéns! Seu pedido foi aprovado. Bem-vindo ao CS!',
                waitForReply: true,
                timeoutMinutes: 60,
                nextOnReply: 1,
                nextOnTimeout: 2
            },
            {
                id: 'step_2',
                type: 'text',
                text: 'Obrigado pela resposta! Aqui estão seus próximos passos...',
                waitForReply: false
            },
            {
                id: 'step_3',
                type: 'text',
                text: 'Lembre-se de acessar nossa plataforma. Qualquer dúvida, estamos aqui!',
                waitForReply: false
            }
        ]
    },
    'CS_PIX': {
        id: 'CS_PIX',
        name: 'CS - PIX Pendente',
        steps: [
            {
                id: 'step_1',
                type: 'text',
                text: 'Seu PIX foi gerado! Aguardamos o pagamento para liberar o acesso ao CS.',
                waitForReply: true,
                timeoutMinutes: 10,
                nextOnReply: 1,
                nextOnTimeout: 2
            },
            {
                id: 'step_2',
                type: 'text',
                text: 'Obrigado pelo contato! Assim que o pagamento for confirmado, você receberá o acesso.',
                waitForReply: false
            },
            {
                id: 'step_3',
                type: 'text',
                text: 'PIX vencido! Entre em contato conosco para gerar um novo.',
                waitForReply: false
            }
        ]
    },
    'FAB_APROVADA': {
        id: 'FAB_APROVADA',
        name: 'FAB - Compra Aprovada',
        steps: [
            {
                id: 'step_1',
                type: 'text',
                text: 'Parabéns! Seu pedido FAB foi aprovado. Prepare-se para a transformação!',
                waitForReply: true,
                timeoutMinutes: 60,
                nextOnReply: 1,
                nextOnTimeout: 2
            },
            {
                id: 'step_2',
                type: 'text',
                text: 'Que bom que respondeu! Sua jornada FAB começa agora...',
                waitForReply: false
            },
            {
                id: 'step_3',
                type: 'text',
                text: 'Acesse nossa área de membros e comece sua transformação hoje mesmo!',
                waitForReply: false
            }
        ]
    },
    'FAB_PIX': {
        id: 'FAB_PIX',
        name: 'FAB - PIX Pendente',
        steps: [
            {
                id: 'step_1',
                type: 'text',
                text: 'Seu PIX FAB foi gerado! Aguardamos o pagamento para iniciar sua transformação.',
                waitForReply: true,
                timeoutMinutes: 10,
                nextOnReply: 1,
                nextOnTimeout: 2
            },
            {
                id: 'step_2',
                type: 'text',
                text: 'Obrigado pelo contato! Logo após o pagamento, você terá acesso completo ao FAB.',
                waitForReply: false
            },
            {
                id: 'step_3',
                type: 'text',
                text: 'PIX vencido! Entre em contato para gerar um novo e não perder essa oportunidade.',
                waitForReply: false
            }
        ]
    }
};

// ============ PERSISTÊNCIA DE DADOS ============

// Garantir que a pasta data existe
async function ensureDataDir() {
    try {
        await fs.mkdir(path.join(__dirname, 'data'), { recursive: true });
    } catch (error) {
        console.log('Pasta data já existe ou erro ao criar:', error.message);
    }
}

// Salvar funis no arquivo
async function saveFunnelsToFile() {
    try {
        await ensureDataDir();
        const funnelsArray = Array.from(funis.values());
        await fs.writeFile(DATA_FILE, JSON.stringify(funnelsArray, null, 2));
        addLog('DATA_SAVE', 'Funis salvos em arquivo: ' + funnelsArray.length + ' funis');
    } catch (error) {
        addLog('DATA_SAVE_ERROR', 'Erro ao salvar funis: ' + error.message);
    }
}

// Carregar funis do arquivo
async function loadFunnelsFromFile() {
    try {
        const data = await fs.readFile(DATA_FILE, 'utf8');
        const funnelsArray = JSON.parse(data);
        
        // Limpar funis atuais e recarregar
        funis.clear();
        
        funnelsArray.forEach(funnel => {
            funis.set(funnel.id, funnel);
        });
        
        addLog('DATA_LOAD', 'Funis carregados do arquivo: ' + funnelsArray.length + ' funis');
        return true;
    } catch (error) {
        addLog('DATA_LOAD_ERROR', 'Erro ao carregar funis (usando padrões): ' + error.message);
        return false;
    }
}

// Salvar conversas ativas (para não perder o que está em andamento)
async function saveConversationsToFile() {
    try {
        await ensureDataDir();
        const conversationsArray = Array.from(conversations.entries()).map(([key, value]) => ({
            remoteJid: key,
            ...value,
            createdAt: value.createdAt.toISOString(),
            lastSystemMessage: value.lastSystemMessage ? value.lastSystemMessage.toISOString() : null,
            lastReply: value.lastReply ? value.lastReply.toISOString() : null
        }));
        
        await fs.writeFile(CONVERSATIONS_FILE, JSON.stringify({
            conversations: conversationsArray,
            stickyInstances: Array.from(stickyInstances.entries())
        }, null, 2));
        
        addLog('DATA_SAVE', 'Conversas salvas: ' + conversationsArray.length + ' conversas');
    } catch (error) {
        addLog('DATA_SAVE_ERROR', 'Erro ao salvar conversas: ' + error.message);
    }
}

// Carregar conversas ativas
async function loadConversationsFromFile() {
    try {
        const data = await fs.readFile(CONVERSATIONS_FILE, 'utf8');
        const parsed = JSON.parse(data);
        
        // Recarregar conversas
        conversations.clear();
        parsed.conversations.forEach(conv => {
            const conversation = {
                ...conv,
                createdAt: new Date(conv.createdAt),
                lastSystemMessage: conv.lastSystemMessage ? new Date(conv.lastSystemMessage) : null,
                lastReply: conv.lastReply ? new Date(conv.lastReply) : null
            };
            conversations.set(conv.remoteJid, conversation);
        });
        
        // Recarregar sticky instances
        stickyInstances.clear();
        parsed.stickyInstances.forEach(([key, value]) => {
            stickyInstances.set(key, value);
        });
        
        addLog('DATA_LOAD', 'Conversas carregadas: ' + parsed.conversations.length + ' conversas');
        return true;
    } catch (error) {
        addLog('DATA_LOAD_ERROR', 'Nenhuma conversa anterior encontrada: ' + error.message);
        return false;
    }
}

// Auto-save periódico (a cada 30 segundos)
setInterval(async () => {
    await saveFunnelsToFile();
    await saveConversationsToFile();
}, 30000);

// Inicializar funis padrão
Object.values(defaultFunnels).forEach(funnel => {
    funis.set(funnel.id, funnel);
});

// ============ MIDDLEWARES ============
app.use(express.json());
app.use(express.static('public')); // Serve arquivos estáticos da pasta public

// ============ FUNÇÕES AUXILIARES ============
function normalizePhone(phone) {
    if (!phone) return '';
    let cleaned = phone.replace(/\D/g, '');
    if (cleaned.length === 10 || cleaned.length === 11) {
        cleaned = '55' + cleaned;
    }
    if (!cleaned.startsWith('55')) {
        cleaned = '55' + cleaned;
    }
    return cleaned;
}

function phoneToRemoteJid(phone) {
    const normalized = normalizePhone(phone);
    return normalized + '@s.whatsapp.net';
}

function extractMessageText(message) {
    if (!message) return '';
    if (message.conversation) return message.conversation;
    if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
    if (message.imageMessage?.caption) return message.imageMessage.caption;
    if (message.videoMessage?.caption) return message.videoMessage.caption;
    if (message.buttonsResponseMessage?.selectedDisplayText) 
        return message.buttonsResponseMessage.selectedDisplayText;
    if (message.listResponseMessage?.singleSelectReply?.selectedRowId)
        return message.listResponseMessage.singleSelectReply.selectedRowId;
    if (message.templateButtonReplyMessage?.selectedId)
        return message.templateButtonReplyMessage.selectedId;
    return '';
}

function checkIdempotency(key, ttl = 5 * 60 * 1000) {
    const now = Date.now();
    for (const [k, timestamp] of idempotencyCache.entries()) {
        if (now - timestamp > ttl) {
            idempotencyCache.delete(k);
        }
    }
    if (idempotencyCache.has(key)) return true;
    idempotencyCache.set(key, now);
    return false;
}

function addLog(type, message, data = null) {
    const log = {
        id: Date.now() + Math.random(),
        timestamp: new Date(),
        type,
        message,
        data
    };
    logs.unshift(log);
    if (logs.length > 1000) {
        logs = logs.slice(0, 1000);
    }
    console.log('[' + log.timestamp.toISOString() + '] ' + type + ': ' + message);
}

// ============ EVOLUTION API ADAPTER ============
async function sendToEvolution(instanceName, endpoint, payload) {
    const url = EVOLUTION_BASE_URL + endpoint + '/' + instanceName;
    try {
        const response = await axios.post(url, payload, {
            headers: {
                'Content-Type': 'application/json',
                'apikey': EVOLUTION_API_KEY
            },
            timeout: 15000
        });
        return { ok: true, data: response.data };
    } catch (error) {
        return { 
            ok: false, 
            error: error.response?.data || error.message,
            status: error.response?.status
        };
    }
}

// ✅ CORREÇÃO: Agora as funções recebem instanceName como parâmetro
async function sendText(remoteJid, text, clientMessageId, instanceName) {
    const textWithId = text + '\u200B[#cmid:' + clientMessageId + ']';
    const payload = {
        number: remoteJid.replace('@s.whatsapp.net', ''),
        text: textWithId
    };
    return await sendToEvolution(instanceName, '/message/sendText', payload);
}

async function sendImage(remoteJid, imageUrl, caption, clientMessageId, instanceName) {
    const captionWithId = caption ? caption + '\u200B[#cmid:' + clientMessageId + ']' : '\u200B[#cmid:' + clientMessageId + ']';
    const payload = {
        number: remoteJid.replace('@s.whatsapp.net', ''),
        mediaMessage: {
            mediatype: 'image',
            media: imageUrl,
            caption: captionWithId
        }
    };
    return await sendToEvolution(instanceName, '/message/sendMedia', payload);
}

async function sendVideo(remoteJid, videoUrl, caption, clientMessageId, instanceName) {
    const captionWithId = caption ? caption + '\u200B[#cmid:' + clientMessageId + ']' : '\u200B[#cmid:' + clientMessageId + ']';
    const payload = {
        number: remoteJid.replace('@s.whatsapp.net', ''),
        mediaMessage: {
            mediatype: 'video',
            media: videoUrl,
            caption: captionWithId
        }
    };
    return await sendToEvolution(instanceName, '/message/sendVideo', payload);
}

// ============ ENVIO COM FALLBACK ============
async function sendWithFallback(remoteJid, type, text, mediaUrl) {
    const clientMessageId = uuidv4();
    const stickyInstance = stickyInstances.get(remoteJid);
    let instancesToTry = [...INSTANCES];
    
    if (stickyInstance) {
        instancesToTry = [stickyInstance, ...INSTANCES.filter(i => i !== stickyInstance)];
    }
    
    let lastError = null;
    
    for (const instanceName of instancesToTry) {
        try {
            addLog('SEND_ATTEMPT', 'Tentando ' + instanceName + ' para ' + remoteJid, { type, clientMessageId });
            
            let result;
            // ✅ CORREÇÃO: Agora passando instanceName para as funções
            if (type === 'text') {
                result = await sendText(remoteJid, text, clientMessageId, instanceName);
            } else if (type === 'image' || type === 'image+text') {
                result = await sendImage(remoteJid, mediaUrl, text, clientMessageId, instanceName);
            } else if (type === 'video' || type === 'video+text') {
                result = await sendVideo(remoteJid, mediaUrl, text, clientMessageId, instanceName);
            }
            
            if (result && result.ok) {
                stickyInstances.set(remoteJid, instanceName);
                return await waitForAck(clientMessageId, remoteJid, instanceName);
            } else {
                lastError = result.error;
                addLog('SEND_FAILED', instanceName + ' falhou: ' + lastError, { remoteJid, type });
            }
        } catch (error) {
            lastError = error.message;
            addLog('SEND_ERROR', instanceName + ' erro: ' + error.message, { remoteJid, type });
        }
    }
    
    addLog('SEND_ALL_FAILED', 'Todas as instâncias falharam para ' + remoteJid, { lastError });
    return { success: false, error: lastError };
}

async function waitForAck(clientMessageId, remoteJid, instanceName) {
    return new Promise((resolve) => {
        const ackData = {
            clientMessageId,
            remoteJid,
            instanceName,
            timestamp: Date.now(),
            resolve
        };
        
        pendingAcks.set(clientMessageId, ackData);
        
        setTimeout(() => {
            if (pendingAcks.has(clientMessageId)) {
                pendingAcks.delete(clientMessageId);
                addLog('ACK_TIMEOUT', 'Timeout de ACK para ' + clientMessageId, { remoteJid, instanceName });
                resolve({ success: false, error: 'ACK timeout' });
            }
        }, ACK_TIMEOUT_MS);
    });
}

// ============ ORQUESTRAÇÃO DE FUNIS ============
async function startFunnel(remoteJid, funnelId, orderCode, customerName, productType, amount) {
    const conversation = {
        remoteJid,
        funnelId,
        stepIndex: 0,
        orderCode,
        customerName,
        productType,
        amount,
        waiting_for_response: false,
        createdAt: new Date(),
        lastSystemMessage: null,
        lastReply: null
    };
    
    conversations.set(remoteJid, conversation);
    addLog('FUNNEL_START', 'Iniciando funil ' + funnelId + ' para ' + remoteJid, { orderCode, productType });
    await sendStep(remoteJid);
}

async function sendStep(remoteJid) {
    const conversation = conversations.get(remoteJid);
    if (!conversation) return;
    
    const funnel = funis.get(conversation.funnelId);
    if (!funnel) return;
    
    const step = funnel.steps[conversation.stepIndex];
    if (!step) return;
    
    const idempotencyKey = 'SEND:' + remoteJid + ':' + conversation.funnelId + ':' + conversation.stepIndex;
    if (checkIdempotency(idempotencyKey)) {
        addLog('STEP_DUPLICATE', 'Passo duplicado ignorado: ' + conversation.funnelId + '[' + conversation.stepIndex + ']');
        return;
    }
    
    addLog('STEP_SEND', 'Enviando passo ' + conversation.stepIndex + ' do funil ' + conversation.funnelId, { step });
    
    // DELAY ANTES (se configurado)
    if (step.delayBefore && step.delayBefore > 0) {
        addLog('STEP_DELAY', 'Aguardando ' + step.delayBefore + 's antes do passo ' + conversation.stepIndex);
        await new Promise(resolve => setTimeout(resolve, step.delayBefore * 1000));
    }
    
    // MOSTRAR DIGITANDO (se configurado)
    if (step.showTyping) {
        await sendTypingIndicator(remoteJid);
    }
    
    let result = { success: true };
    
    // PROCESSAR TIPO DO PASSO
    if (step.type === 'delay') {
        // Passo de delay puro
        const delaySeconds = step.delaySeconds || 10;
        addLog('STEP_DELAY', 'Executando delay de ' + delaySeconds + 's no passo ' + conversation.stepIndex);
        await new Promise(resolve => setTimeout(resolve, delaySeconds * 1000));
        
    } else if (step.type === 'typing') {
        // Passo de digitando puro
        const typingSeconds = step.typingSeconds || 3;
        addLog('STEP_TYPING', 'Mostrando digitando por ' + typingSeconds + 's no passo ' + conversation.stepIndex);
        await sendTypingIndicator(remoteJid, typingSeconds);
        
    } else if (step.type === 'wait_reply') {
        // Passo de aguardar resposta (gatilho)
        addLog('STEP_WAIT_REPLY', 'Aguardando resposta do cliente no passo ' + conversation.stepIndex);
        conversation.waiting_for_response = true;
        
        // Configurar timeout se especificado
        if (step.timeoutMinutes) {
            setTimeout(() => {
                handleStepTimeout(remoteJid, conversation.stepIndex);
            }, step.timeoutMinutes * 60 * 1000);
        }
        
        // Para passos de aguardar resposta, não continuar automaticamente
        conversations.set(remoteJid, conversation);
        return;
        
    } else {
        // Passo de mensagem (texto, imagem, vídeo)
        result = await sendWithFallback(remoteJid, step.type, step.text, step.mediaUrl);
    }
    
    if (result.success) {
        conversation.lastSystemMessage = new Date();
        
        if (step.waitForReply && step.type !== 'delay' && step.type !== 'typing' && step.type !== 'wait_reply') {
            // Aguardar resposta em mensagens normais (funcionalidade antiga mantida)
            conversation.waiting_for_response = true;
            
            if (step.timeoutMinutes) {
                setTimeout(() => {
                    handleStepTimeout(remoteJid, conversation.stepIndex);
                }, step.timeoutMinutes * 60 * 1000);
            }
        } else {
            // Avançar automaticamente para o próximo passo
            await advanceConversation(remoteJid, null, 'auto');
        }
        
        conversations.set(remoteJid, conversation);
        addLog('STEP_SUCCESS', 'Passo executado com sucesso: ' + conversation.funnelId + '[' + conversation.stepIndex + ']');
    } else {
        addLog('STEP_FAILED', 'Falha no envio do passo: ' + result.error, { conversation });
    }
}

// NOVA FUNÇÃO: Enviar indicador de digitação
async function sendTypingIndicator(remoteJid, durationSeconds = 3) {
    const instanceName = stickyInstances.get(remoteJid) || INSTANCES[0];
    
    try {
        // Iniciar digitação
        await sendToEvolution(instanceName, '/chat/sendPresence', {
            number: remoteJid.replace('@s.whatsapp.net', ''),
            presence: 'composing'
        });
        
        addLog('TYPING_START', 'Iniciando digitação para ' + remoteJid + ' por ' + durationSeconds + 's');
        
        // Aguardar o tempo especificado
        await new Promise(resolve => setTimeout(resolve, durationSeconds * 1000));
        
        // Parar digitação
        await sendToEvolution(instanceName, '/chat/sendPresence', {
            number: remoteJid.replace('@s.whatsapp.net', ''),
            presence: 'paused'
        });
        
        addLog('TYPING_END', 'Finalizando digitação para ' + remoteJid);
        
    } catch (error) {
        addLog('TYPING_ERROR', 'Erro ao enviar digitação: ' + error.message, { remoteJid });
    }
}

async function advanceConversation(remoteJid, replyText, reason) {
    const conversation = conversations.get(remoteJid);
    if (!conversation) return;
    
    const funnel = funis.get(conversation.funnelId);
    if (!funnel) return;
    
    const currentStep = funnel.steps[conversation.stepIndex];
    if (!currentStep) return;
    
    let nextStepIndex;
    if (reason === 'reply' && currentStep.nextOnReply !== undefined) {
        nextStepIndex = currentStep.nextOnReply;
    } else if (reason === 'timeout' && currentStep.nextOnTimeout !== undefined) {
        nextStepIndex = currentStep.nextOnTimeout;
    } else {
        nextStepIndex = conversation.stepIndex + 1;
    }
    
    if (nextStepIndex >= funnel.steps.length) {
        addLog('FUNNEL_END', 'Funil ' + conversation.funnelId + ' concluído para ' + remoteJid);
        return;
    }
    
    conversation.stepIndex = nextStepIndex;
    conversation.waiting_for_response = false;
    if (reason === 'reply') {
        conversation.lastReply = new Date();
    }
    
    conversations.set(remoteJid, conversation);
    addLog('STEP_ADVANCE', 'Avançando para passo ' + nextStepIndex + ' (motivo: ' + reason + ')', { conversation });
    await sendStep(remoteJid);
}

async function handleStepTimeout(remoteJid, expectedStepIndex) {
    const conversation = conversations.get(remoteJid);
    if (!conversation || conversation.stepIndex !== expectedStepIndex || !conversation.waiting_for_response) {
        return;
    }
    addLog('STEP_TIMEOUT', 'Timeout do passo ' + expectedStepIndex + ' para ' + remoteJid);
    await advanceConversation(remoteJid, null, 'timeout');
}

// ============ WEBHOOKS ============
app.post('/webhook/kirvano', async (req, res) => {
    try {
        const data = req.body;
        const event = String(data.event || '').toUpperCase();
        const status = String(data.status || data.payment_status || '').toUpperCase();
        const method = String(data.payment?.method || data.payment_method || '').toUpperCase();
        
        const saleId = data.sale_id || data.checkout_id;
        const orderCode = saleId || 'ORDER_' + Date.now();
        const customerName = data.customer?.name || 'Cliente';
        const customerPhone = data.customer?.phone_number || '';
        const totalPrice = data.total_price || 'R$ 0,00';
        
        const remoteJid = phoneToRemoteJid(customerPhone);
        if (!remoteJid || remoteJid === '@s.whatsapp.net') {
            return res.json({ success: false, message: 'Telefone inválido' });
        }
        
        const idempotencyKey = 'KIRVANO:' + event + ':' + remoteJid + ':' + orderCode;
        if (checkIdempotency(idempotencyKey)) {
            return res.json({ success: true, message: 'Evento duplicado ignorado' });
        }
        
        let productType = 'UNKNOWN';
        if (data.products && data.products.length > 0) {
            const offerId = data.products[0].offer_id;
            productType = PRODUCT_MAPPING[offerId] || 'UNKNOWN';
        }
        
        addLog('KIRVANO_EVENT', event + ' - ' + productType + ' - ' + customerName, { orderCode, remoteJid });
        
        let funnelId;
        const isApproved = event.includes('APPROVED') || event.includes('PAID') || status === 'APPROVED';
        const isPix = method.includes('PIX') || event.includes('PIX');
        
        if (isApproved) {
            const pixTimeout = pixTimeouts.get(remoteJid);
            if (pixTimeout) {
                clearTimeout(pixTimeout.timeout);
                pixTimeouts.delete(remoteJid);
                addLog('PIX_TIMEOUT_CANCELED', 'Timeout cancelado para ' + remoteJid, { orderCode });
            }
            
            funnelId = productType === 'FAB' ? 'FAB_APROVADA' : 'CS_APROVADA';
            await startFunnel(remoteJid, funnelId, orderCode, customerName, productType, totalPrice);
            
        } else if (isPix) {
            funnelId = productType === 'FAB' ? 'FAB_PIX' : 'CS_PIX';
            
            const existingTimeout = pixTimeouts.get(remoteJid);
            if (existingTimeout) {
                clearTimeout(existingTimeout.timeout);
            }
            
            await startFunnel(remoteJid, funnelId, orderCode, customerName, productType, totalPrice);
            
            const timeout = setTimeout(async () => {
                const conversation = conversations.get(remoteJid);
                if (conversation && conversation.orderCode === orderCode) {
                    const funnel = funis.get(conversation.funnelId);
                    if (funnel && funnel.steps[2]) {
                        conversation.stepIndex = 2;
                        conversation.waiting_for_response = false;
                        conversations.set(remoteJid, conversation);
                        await sendStep(remoteJid);
                    }
                }
                pixTimeouts.delete(remoteJid);
            }, PIX_TIMEOUT);
            
            pixTimeouts.set(remoteJid, { timeout, orderCode, createdAt: new Date() });
        }
        
        res.json({ success: true, message: 'Processado', funnelId });
        
    } catch (error) {
        addLog('KIRVANO_ERROR', error.message, { body: req.body });
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/webhook/evolution', async (req, res) => {
    try {
        const data = req.body;
        const messageData = data.data;
        
        if (!messageData || !messageData.key) {
            return res.json({ success: true });
        }
        
        const remoteJid = messageData.key.remoteJid;
        const fromMe = messageData.key.fromMe;
        const messageText = extractMessageText(messageData.message);
        
        if (fromMe) {
            const clientMessageIdMatch = messageText.match(/\[#cmid:([^\]]+)\]/);
            if (clientMessageIdMatch) {
                const clientMessageId = clientMessageIdMatch[1];
                const pendingAck = pendingAcks.get(clientMessageId);
                
                if (pendingAck) {
                    pendingAcks.delete(clientMessageId);
                    addLog('ACK_RECEIVED', 'ACK confirmado: ' + clientMessageId, { remoteJid });
                    pendingAck.resolve({ success: true, clientMessageId });
                }
            }
        } else {
            const conversation = conversations.get(remoteJid);
            
            if (conversation && conversation.waiting_for_response) {
                const idempotencyKey = 'REPLY:' + remoteJid + ':' + conversation.funnelId + ':' + conversation.stepIndex;
                if (checkIdempotency(idempotencyKey)) {
                    return res.json({ success: true, message: 'Resposta duplicada' });
                }
                
                addLog('CLIENT_REPLY', 'Resposta recebida de ' + remoteJid, { 
                    text: messageText.substring(0, 100),
                    step: conversation.stepIndex 
                });
                
                await advanceConversation(remoteJid, messageText, 'reply');
            }
        }
        
        res.json({ success: true });
        
    } catch (error) {
        addLog('EVOLUTION_ERROR', error.message, { body: req.body });
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ API ENDPOINTS ============

// Dashboard - estatísticas principais
app.get('/api/dashboard', (req, res) => {
    const stats = {
        active_conversations: conversations.size,
        pending_acks: pendingAcks.size,
        pending_pix: pixTimeouts.size,
        total_funnels: funis.size,
        total_instances: INSTANCES.length
    };
    
    res.json({
        success: true,
        data: stats,
        timestamp: new Date().toISOString()
    });
});

// Funis - CRUD completo
app.get('/api/funnels', (req, res) => {
    const funnelsList = Array.from(funis.values()).map(funnel => ({
        ...funnel,
        isDefault: funnel.id.includes('_APROVADA') || funnel.id.includes('_PIX'),
        stepCount: funnel.steps.length
    }));
    
    res.json({
        success: true,
        data: funnelsList
    });
});

app.post('/api/funnels', (req, res) => {
    const funnel = req.body;
    
    if (!funnel.id || !funnel.name || !funnel.steps) {
        return res.status(400).json({ 
            success: false, 
            error: 'ID, nome e passos são obrigatórios' 
        });
    }
    
    funis.set(funnel.id, funnel);
    addLog('FUNNEL_SAVED', 'Funil salvo: ' + funnel.id);
    
    // Salvar imediatamente no arquivo
    saveFunnelsToFile();
    
    res.json({ 
        success: true, 
        message: 'Funil salvo com sucesso',
        data: funnel
    });
});

app.delete('/api/funnels/:id', (req, res) => {
    const { id } = req.params;
    
    // Proteger funis padrão
    if (id.includes('_APROVADA') || id.includes('_PIX')) {
        return res.status(400).json({ 
            success: false, 
            error: 'Não é possível excluir funis padrão' 
        });
    }
    
    if (funis.has(id)) {
        funis.delete(id);
        addLog('FUNNEL_DELETED', 'Funil excluído: ' + id);
        
        // Salvar imediatamente no arquivo
        saveFunnelsToFile();
        
        res.json({ success: true, message: 'Funil excluído com sucesso' });
    } else {
        res.status(404).json({ success: false, error: 'Funil não encontrado' });
    }
});

// Conversas/Envios
app.get('/api/conversations', (req, res) => {
    const conversationsList = Array.from(conversations.entries()).map(([remoteJid, conv]) => ({
        id: remoteJid,
        phone: remoteJid.replace('@s.whatsapp.net', ''),
        customerName: conv.customerName,
        productType: conv.productType,
        funnelId: conv.funnelId,
        stepIndex: conv.stepIndex,
        waiting_for_response: conv.waiting_for_response,
        createdAt: conv.createdAt,
        lastSystemMessage: conv.lastSystemMessage,
        lastReply: conv.lastReply,
        orderCode: conv.orderCode,
        amount: conv.amount,
        stickyInstance: stickyInstances.get(remoteJid)
    }));
    
    // Ordenar por mais recente primeiro
    conversationsList.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    
    res.json({
        success: true,
        data: conversationsList
    });
});

// Logs recentes
app.get('/api/logs', (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    const recentLogs = logs.slice(0, limit).map(log => ({
        id: log.id,
        timestamp: log.timestamp,
        type: log.type,
        message: log.message
    }));
    
    res.json({
        success: true,
        data: recentLogs
    });
});

// Teste de envio
app.post('/api/send-test', async (req, res) => {
    const { remoteJid, type, text, mediaUrl } = req.body;
    
    if (!remoteJid || !type) {
        return res.status(400).json({ 
            success: false, 
            error: 'remoteJid e type são obrigatórios' 
        });
    }
    
    addLog('TEST_SEND', 'Teste de envio: ' + type + ' para ' + remoteJid);
    
    const result = await sendWithFallback(remoteJid, type, text, mediaUrl);
    
    if (result.success) {
        res.json({ success: true, message: 'Mensagem enviada com sucesso!' });
    } else {
        res.status(500).json({ success: false, error: result.error });
    }
});

// Debug da Evolution API
app.get('/api/debug/evolution', async (req, res) => {
    const debugInfo = {
        evolution_base_url: EVOLUTION_BASE_URL,
        evolution_api_key_configured: EVOLUTION_API_KEY !== 'SUA_API_KEY_AQUI',
        evolution_api_key_length: EVOLUTION_API_KEY.length,
        instances: INSTANCES,
        test_results: []
    };
    
    // Testar conexão com primeiro endpoint
    try {
        const testInstance = INSTANCES[0];
        const url = EVOLUTION_BASE_URL + '/message/sendText/' + testInstance;
        
        const response = await axios.post(url, {
            number: '5511999999999',
            text: 'teste'
        }, {
            headers: {
                'Content-Type': 'application/json',
                'apikey': EVOLUTION_API_KEY
            },
            timeout: 10000,
            validateStatus: () => true // Aceitar qualquer status para debug
        });
        
        debugInfo.test_results.push({
            instance: testInstance,
            url: url,
            status: response.status,
            response: response.data,
            headers: response.headers
        });
        
    } catch (error) {
        debugInfo.test_results.push({
            instance: INSTANCES[0],
            error: error.message,
            code: error.code
        });
    }
    
    res.json(debugInfo);
});

// ============ SERVIR FRONTEND ============
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Inicialização - carregar dados persistidos
async function initializeData() {
    console.log('🔄 Carregando dados persistidos...');
    
    const funnelsLoaded = await loadFunnelsFromFile();
    if (!funnelsLoaded) {
        console.log('📋 Usando funis padrão');
    }
    
    const conversationsLoaded = await loadConversationsFromFile();
    if (!conversationsLoaded) {
        console.log('💬 Nenhuma conversa anterior encontrada');
    }
    
    console.log('✅ Inicialização concluída');
    console.log('📊 Funis carregados:', funis.size);
    console.log('💬 Conversas ativas:', conversations.size);
}

// ============ INICIALIZAÇÃO ============
app.listen(PORT, async () => {
    console.log('='.repeat(60));
    console.log('🚀 KIRVANO SYSTEM - BACKEND API [VERSÃO CORRIGIDA]');
    console.log('='.repeat(60));
    console.log('Porta:', PORT);
    console.log('Evolution:', EVOLUTION_BASE_URL);
    console.log('API Key configurada:', EVOLUTION_API_KEY !== 'SUA_API_KEY_AQUI');
    console.log('Instâncias:', INSTANCES.length);
    console.log('');
    console.log('🔧 CORREÇÕES APLICADAS:');
    console.log('  ✅ sendText() agora recebe instanceName');
    console.log('  ✅ sendImage() agora recebe instanceName');  
    console.log('  ✅ sendVideo() agora recebe instanceName');
    console.log('  ✅ URLs corretas: /message/sendText/{instance}');
    console.log('  ✅ Fallback funcionando corretamente');
    console.log('');
    console.log('📡 API Endpoints:');
    console.log('  GET  /api/dashboard     - Estatísticas');
    console.log('  GET  /api/funnels       - Listar funis');
    console.log('  POST /api/funnels       - Criar/editar funil');
    console.log('  GET  /api/conversations  - Listar conversas');
    console.log('  GET  /api/logs          - Logs recentes');
    console.log('  POST /api/send-test     - Teste de envio');
    console.log('  GET  /api/debug/evolution - Debug Evolution API');
    console.log('');
    console.log('📨 Webhooks:');
    console.log('  POST /webhook/kirvano   - Eventos Kirvano');
    console.log('  POST /webhook/evolution - Eventos Evolution');
    console.log('');
    console.log('🌐 Frontend: http://localhost:' + PORT);
    console.log('🧪 Testes: http://localhost:' + PORT + '/test.html');
    console.log('='.repeat(60));
    
    // Carregar dados persistidos
    await initializeData();
});
