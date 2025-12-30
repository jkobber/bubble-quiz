
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerHandlers } from '@/lib/game/socket-handlers';
import { GameManager } from '@/lib/game/GameManager';

describe('Socket Handlers - Lobby Closure Repro', () => {
    let gm: GameManager;
    let io: any;
    let socket: any;

    beforeEach(() => {
        gm = new GameManager();
        io = {
            to: vi.fn().mockReturnThis(),
            emit: vi.fn(),
        };
        socket = {
            id: 'sock-123',
            join: vi.fn(),
            emit: vi.fn(),
            on: vi.fn(),
        };
    });

    it('should handle delete_room with string payload (Client behavior)', () => {
        const handlers: any = {};
        socket.on = vi.fn((event, cb) => { handlers[event] = cb; });
        registerHandlers(io, socket, gm);

        const room = gm.createRoom('DEL', 't1');
        room.players['t1'] = { token: 't1', socketId: 'sock-123' } as any;

        // Simulate client sending string payload
        handlers['delete_room']('DEL');

        // Expect room to be deleted
        expect(gm.getRoom('DEL')).toBeUndefined();
        
        // Expect success events
        expect(io.to).toHaveBeenCalledWith('DEL');
        // Check exact call for room:deleted
        expect(io.emit).toHaveBeenCalledWith('room:deleted');
    });
});
