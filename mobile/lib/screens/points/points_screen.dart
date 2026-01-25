import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../config/app_theme.dart';
import '../../services/auth_service.dart';
import '../../services/points_service.dart';

class PointsScreen extends StatefulWidget {
  const PointsScreen({super.key});

  @override
  State<PointsScreen> createState() => _PointsScreenState();
}

class _PointsScreenState extends State<PointsScreen> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final userId = context.read<AuthService>().userId;
      if (userId.isNotEmpty) {
        context.read<PointsService>().loadWallet(userId);
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final authService = context.watch<AuthService>();
    
    if (!authService.isAuthenticated) {
      return Scaffold(
        appBar: AppBar(title: const Text('Reward Points')),
        body: const Center(child: Text('Please login to view your points')),
      );
    }

    return Scaffold(
      appBar: AppBar(title: const Text('Reward Points')),
      body: Consumer<PointsService>(
        builder: (context, service, _) {
          if (service.isLoading) {
            return const Center(child: CircularProgressIndicator());
          }
          return RefreshIndicator(
            onRefresh: () => service.refresh(authService.userId),
            child: SingleChildScrollView(
              physics: const AlwaysScrollableScrollPhysics(),
              padding: const EdgeInsets.all(16),
              child: Column(
                children: [
                  Container(
                    padding: const EdgeInsets.all(24),
                    decoration: BoxDecoration(
                      gradient: const LinearGradient(
                        colors: [Color(0xFF1a1a1a), Color(0xFF333333)],
                      ),
                      borderRadius: BorderRadius.circular(16),
                    ),
                    child: Column(
                      children: [
                        const Text('Available Points', style: TextStyle(color: Colors.white70, fontSize: 14)),
                        const SizedBox(height: 8),
                        Text('${service.availablePoints}', style: const TextStyle(color: Colors.white, fontSize: 48, fontWeight: FontWeight.bold)),
                        const SizedBox(height: 16),
                        Row(
                          mainAxisAlignment: MainAxisAlignment.spaceAround,
                          children: [
                            _buildStat('Total', service.totalPoints),
                            _buildStat('Pending', service.pendingPoints),
                            _buildStat('Redeemed', service.redeemedPoints),
                          ],
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 24),
                  Container(
                    padding: const EdgeInsets.all(16),
                    decoration: BoxDecoration(
                      color: AppTheme.warningColor.withOpacity(0.1),
                      borderRadius: BorderRadius.circular(12),
                    ),
                    child: const Row(
                      children: [
                        Icon(Icons.info_outline, color: AppTheme.warningColor),
                        SizedBox(width: 12),
                        Expanded(child: Text('Reward points have no fixed cash value.', style: TextStyle(fontSize: 12))),
                      ],
                    ),
                  ),
                  const SizedBox(height: 24),
                  const Align(
                    alignment: Alignment.centerLeft,
                    child: Text('Recent Activity', style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
                  ),
                  const SizedBox(height: 16),
                  if (service.transactions.isEmpty)
                    const Padding(padding: EdgeInsets.all(32), child: Text('No points activity yet'))
                  else
                    ...service.transactions.map((tx) => ListTile(
                      leading: const CircleAvatar(child: Icon(Icons.stars)),
                      title: Text(service.getSourceTypeText(tx['sourceType'] ?? '')),
                      subtitle: Text(service.getStatusText(tx['status'] ?? '')),
                      trailing: Text('+${tx['points'] ?? 0}', style: const TextStyle(fontWeight: FontWeight.bold)),
                    )),
                ],
              ),
            ),
          );
        },
      ),
    );
  }

  Widget _buildStat(String label, int value) {
    return Column(
      children: [
        Text(label, style: const TextStyle(color: Colors.white54, fontSize: 12)),
        const SizedBox(height: 4),
        Text('$value', style: const TextStyle(color: Colors.white, fontSize: 18, fontWeight: FontWeight.bold)),
      ],
    );
  }
}
