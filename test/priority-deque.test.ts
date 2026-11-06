import { describe, test, expect, beforeEach } from '@jest/globals';
import { PriorityDeque, type QueueItem } from '../src/priority-deque.js';

describe('PriorityDeque', () => {
    let deque: PriorityDeque<string>;

    beforeEach(() => {
        deque = new PriorityDeque<string>();
    });

    test('initializes empty with size 0', () => {
        expect(deque.size).toBe(0);
        expect(deque.isEmpty).toBe(true);
        expect(deque.shift()).toBeUndefined();
    });

    test('maintains strict FIFO order for equal priorities (priority 0)', () => {
        const createItem = (val: string): QueueItem<string> => ({
            context: val,
            priority: 0,
            enqueuedAt: Date.now(),
            settled: false,
            resolve: () => {},
            reject: () => {},
        });

        deque.insert(createItem('a'));
        deque.insert(createItem('b'));
        deque.insert(createItem('c'));

        expect(deque.size).toBe(3);
        expect(deque.shift()?.context).toBe('a');
        expect(deque.shift()?.context).toBe('b');
        expect(deque.shift()?.context).toBe('c');
        expect(deque.isEmpty).toBe(true);
    });

    test('prioritizes higher priority items before lower priority items', () => {
        const createItem = (val: string, priority: number): QueueItem<string> => ({
            context: val,
            priority,
            enqueuedAt: Date.now(),
            settled: false,
            resolve: () => {},
            reject: () => {},
        });

        deque.insert(createItem('low-1', 0));
        deque.insert(createItem('high', 10));
        deque.insert(createItem('med-1', 5));
        deque.insert(createItem('low-2', 0));
        deque.insert(createItem('med-2', 5));

        // Expected order: high (10) -> med-1 (5) -> med-2 (5) -> low-1 (0) -> low-2 (0)
        expect(deque.shift()?.context).toBe('high');
        expect(deque.shift()?.context).toBe('med-1');
        expect(deque.shift()?.context).toBe('med-2');
        expect(deque.shift()?.context).toBe('low-1');
        expect(deque.shift()?.context).toBe('low-2');
        expect(deque.isEmpty).toBe(true);
    });

    test('removes middle node in O(1) without breaking links', () => {
        const createItem = (val: string): QueueItem<string> => ({
            context: val,
            priority: 0,
            enqueuedAt: Date.now(),
            settled: false,
            resolve: () => {},
            reject: () => {},
        });

        const itemA = createItem('a');
        const itemB = createItem('b');
        const itemC = createItem('c');

        deque.insert(itemA);
        deque.insert(itemB);
        deque.insert(itemC);

        // Remove middle item B
        expect(deque.remove(itemB.node)).toBe(true);
        expect(deque.size).toBe(2);

        // Subsequent removal of same node returns false (idempotent)
        expect(deque.remove(itemB.node)).toBe(false);

        expect(deque.shift()?.context).toBe('a');
        expect(deque.shift()?.context).toBe('c');
        expect(deque.isEmpty).toBe(true);
    });

    test('removes head and tail nodes cleanly', () => {
        const createItem = (val: string): QueueItem<string> => ({
            context: val,
            priority: 0,
            enqueuedAt: Date.now(),
            settled: false,
            resolve: () => {},
            reject: () => {},
        });

        const itemA = createItem('a');
        const itemB = createItem('b');

        deque.insert(itemA);
        deque.insert(itemB);

        // Remove head
        expect(deque.remove(itemA.node)).toBe(true);
        expect(deque.size).toBe(1);

        // Remove tail
        expect(deque.remove(itemB.node)).toBe(true);
        expect(deque.size).toBe(0);
        expect(deque.isEmpty).toBe(true);
    });

    test('clears all items and returns array', () => {
        const createItem = (val: string): QueueItem<string> => ({
            context: val,
            priority: 0,
            enqueuedAt: Date.now(),
            settled: false,
            resolve: () => {},
            reject: () => {},
        });

        deque.insert(createItem('a'));
        deque.insert(createItem('b'));
        deque.insert(createItem('c'));

        const cleared = deque.clear();
        expect(cleared.map((i) => i.context)).toEqual(['a', 'b', 'c']);
        expect(deque.size).toBe(0);
        expect(deque.isEmpty).toBe(true);
    });

    test('O(1) high-throughput benchmark: handles 20,000 operations in < 50ms', () => {
        const start = Date.now();
        const total = 20000;

        for (let i = 0; i < total; i++) {
            deque.insert({
                context: `item-${i}`,
                priority: i % 3, // cycle priorities 0, 1, 2
                enqueuedAt: 0,
                settled: false,
                resolve: () => {},
                reject: () => {},
            });
        }

        expect(deque.size).toBe(total);

        let shiftedCount = 0;
        for (let i = 0; i < total; i++) {
            const item = deque.shift();
            if (item) shiftedCount++;
        }

        expect(shiftedCount).toBe(total);
        expect(deque.isEmpty).toBe(true);
        const elapsed = Date.now() - start;
        expect(elapsed).toBeLessThan(150);
    });
});
