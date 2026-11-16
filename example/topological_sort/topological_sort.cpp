#include <iostream>
using namespace std;

int n = 7, m = 6;
int from[6] = {0, 0, 1, 2, 3, 2};
int to[6] = {1, 2, 3, 3, 4, 5}; // 节点 6 是孤立点。
int indegree[7], visited[7], queue_data[7], order[7];
int head = 0, tail = 0, count = 0, u = -1, v = -1;

int main() {
    for (int edge = 0; edge < m; ++edge) ++indegree[to[edge]];
    for (int node = 0; node < n; ++node)
        if (indegree[node] == 0) queue_data[tail++] = node;
    while (head < tail) {
        u = queue_data[head++];
        visited[u] = 1;
        order[count++] = u;
        for (int edge = 0; edge < m; ++edge) {
            if (from[edge] != u) continue;
            v = to[edge];
            --indegree[v]; // @probe: 删除当前节点发出的边
            if (indegree[v] == 0) queue_data[tail++] = v;
        }
    }
    if (count != n) cout << "CYCLE\n";
    for (int i = 0; i < count; ++i) cout << order[i] << ' ';
    cout << '\n';
    return 0;
}
