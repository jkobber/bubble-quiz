import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerHandlers } from '@/lib/game/socket-handlers';
import { GameManager } from '@/lib/game/GameManager';

describe('Lobby Deletion', () => {
    let gm: GameManager;
    let io: any;
    let hostSocket: any;
    let playerSocket: any;

    beforeEach(() => {
        gm = new GameManager();
        io = {
            to: vi.fn().mockReturnThis(),
            emit: vi.fn(),
        };
        // Mock host socket
        hostSocket = {
            id: 'host-sock',
            join: vi.fn(),
            emit: vi.fn(),
            on: vi.fn(),
        };
        // Mock another player socket
        playerSocket = {
            id: 'player-sock',
            join: vi.fn(),
            emit: vi.fn(),
            on: vi.fn(),
        };
    });

    it('should broadcast room:deleted to all players including host', () => {
        const handlers: any = {};
        
        // Helper to bind handlers
        const bind = (sock: any) => {
            sock.on = vi.fn((event, cb) => { handlers[event] = cb; });
            registerHandlers(io, sock, gm);
        };
        
        // 1. Setup Room
        bind(hostSocket);
        const roomCode = 'DELETE_TEST';
        const room = gm.createRoom(roomCode, 'host-token');
        room.players['host-token'] = { 
            token: 'host-token', 
            socketId: 'host-sock', 
            name: 'Host', 
            connected: true 
        } as any;
        hostSocket.join(roomCode); // Host joins socket room

        // 2. Add another player
        bind(playerSocket);
        room.players['player-token'] = { 
            token: 'player-token', 
            socketId: 'player-sock', 
            name: 'Player', 
            connected: true 
        } as any;
        playerSocket.join(roomCode);

        // 3. Trigger delete_room from Host
        // Note: bind overwrites handlers, so we need to grab the delete_room handler bound to hostSocket
        // We re-bind host to get clean access or just use the storage.
        // Actually, registerHandlers attaches events. We mocked .on to store them.
        // We need to execute the 'delete_room' callback that was registered for the host.
        
        // Re-simulate handler registration for host to capture the callback
        const hostHandlers: any = {};
        hostSocket.on = vi.fn((event, cb) => { hostHandlers[event] = cb; });
        registerHandlers(io, hostSocket, gm);

        hostHandlers['delete_room']({ code: roomCode });

        // 4. Verification
        expect(gm.getRoom(roomCode)).toBeUndefined(); // Room should be gone
        
        // Ensure phase is finished to kill any zombie loops
        expect(room.phase).toBe('finished');

        // io.to(code).emit('room:deleted') should have been called
        expect(io.to).toHaveBeenCalledWith(roomCode);
        expect(io.emit).toHaveBeenCalledWith('room:deleted');
        // socket.emit('room:deleted') should also be called explicitly
        expect(hostSocket.emit).toHaveBeenCalledWith('room:deleted');
    });

    it('should handle mixed-case code for deletion', () => {
        const handlers: any = {};
        const bind = (sock: any) => {
            sock.on = vi.fn((event, cb) => { handlers[event] = cb; });
            registerHandlers(io, sock, gm);
        };

        const roomCode = 'MIXED';
        const room = gm.createRoom(roomCode, 'host-token');
        room.players['host-token'] = { token: 'host-token', socketId: 'host-sock' } as any;

        bind(hostSocket);
        
        // Try to delete with lowercase code
        handlers['delete_room']({ code: 'mixed' });

        expect(gm.getRoom(roomCode)).toBeUndefined();
        expect(hostSocket.emit).toHaveBeenCalledWith('room:deleted');
    });

    it('should safely handle undefined code without crashing', () => {
        const handlers: any = {};
        const bind = (sock: any) => {
            sock.on = vi.fn((event, cb) => { handlers[event] = cb; });
            registerHandlers(io, sock, gm);
        };

        bind(hostSocket);
        
        // Try to delete with missing code property
        // @ts-ignore
        handlers['delete_room']({}); 
        // Or undefined
        handlers['delete_room']({ code: undefined });

        // Should just not crash. 
        // Optionally expect an error emit if we decide to implement strict validation in handlers
        // But for now, ensuring no exception is key.
    });

    it('should emit error if unauthorized user tries to delete', () => {
        const handlers: any = {};
        const bind = (sock: any) => {
            sock.on = vi.fn((event, cb) => { handlers[event] = cb; });
            registerHandlers(io, sock, gm);
        };

        const roomCode = 'AUTH_TEST';
        const room = gm.createRoom(roomCode, 'host-token');
        room.players['host-token'] = { token: 'host-token', socketId: 'host-sock' } as any;
        room.players['player-token'] = { token: 'player-token', socketId: 'player-sock' } as any;

        bind(playerSocket);
        
        // Try to delete as player
        handlers['delete_room']({ code: roomCode });

        expect(gm.getRoom(roomCode)).toBeDefined(); // Should still exist
        expect(playerSocket.emit).toHaveBeenCalledWith('error', expect.stringContaining('Failed to delete'));
    });

    it('should emit room:deleted if room does not exist (cleanup)', () => {
        const handlers: any = {};
        const bind = (sock: any) => {
            sock.on = vi.fn((event, cb) => { handlers[event] = cb; });
            registerHandlers(io, sock, gm);
        };

        bind(hostSocket);
        
        // Try to delete non-existent room
        handlers['delete_room']({ code: 'GHOST_ROOM' });

        expect(hostSocket.emit).toHaveBeenCalledWith('room:deleted');
    });
});
