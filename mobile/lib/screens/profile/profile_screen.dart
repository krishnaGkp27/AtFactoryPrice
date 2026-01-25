import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';
import 'package:share_plus/share_plus.dart';
import '../../config/app_theme.dart';
import '../../services/auth_service.dart';

class ProfileScreen extends StatelessWidget {
  const ProfileScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Profile')),
      body: Consumer<AuthService>(
        builder: (context, authService, _) {
          if (!authService.isAuthenticated) {
            return const Center(child: Text('Please login'));
          }
          return SingleChildScrollView(
            padding: const EdgeInsets.all(16),
            child: Column(
              children: [
                // Profile Header
                CircleAvatar(
                  radius: 48,
                  backgroundColor: AppTheme.primaryColor,
                  child: Text(
                    authService.displayName[0].toUpperCase(),
                    style: const TextStyle(fontSize: 32, color: Colors.white, fontWeight: FontWeight.bold),
                  ),
                ),
                const SizedBox(height: 16),
                Text(authService.displayName, style: const TextStyle(fontSize: 24, fontWeight: FontWeight.bold)),
                Text(authService.userEmail, style: const TextStyle(color: AppTheme.textSecondary)),
                const SizedBox(height: 24),
                // Referral Card
                if (authService.referralCode != null)
                  Container(
                    padding: const EdgeInsets.all(16),
                    decoration: BoxDecoration(
                      gradient: LinearGradient(
                        colors: [AppTheme.successColor.withOpacity(0.1), AppTheme.successColor.withOpacity(0.05)],
                      ),
                      borderRadius: BorderRadius.circular(12),
                      border: Border.all(color: AppTheme.successColor.withOpacity(0.3)),
                    ),
                    child: Column(
                      children: [
                        const Text('Your Referral Code', style: TextStyle(color: AppTheme.textSecondary)),
                        const SizedBox(height: 8),
                        Text(
                          authService.referralCode!,
                          style: const TextStyle(fontSize: 24, fontWeight: FontWeight.bold, letterSpacing: 2),
                        ),
                        const SizedBox(height: 16),
                        Row(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            OutlinedButton.icon(
                              onPressed: () {
                                Clipboard.setData(ClipboardData(text: authService.referralCode!));
                                ScaffoldMessenger.of(context).showSnackBar(
                                  const SnackBar(content: Text('Referral code copied!')),
                                );
                              },
                              icon: const Icon(Icons.copy),
                              label: const Text('Copy'),
                            ),
                            const SizedBox(width: 12),
                            ElevatedButton.icon(
                              onPressed: () {
                                Share.share(
                                  'Join AtFactoryPrice using my referral code: ${authService.referralCode!}\n\nhttps://atfactoryprice.com/signup?ref=${authService.referralCode}',
                                );
                              },
                              icon: const Icon(Icons.share),
                              label: const Text('Share'),
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                const SizedBox(height: 24),
                // Menu Options
                _buildMenuItem(context, Icons.shopping_bag_outlined, 'My Orders', () {}),
                _buildMenuItem(context, Icons.location_on_outlined, 'Addresses', () {}),
                _buildMenuItem(context, Icons.settings_outlined, 'Settings', () {}),
                _buildMenuItem(context, Icons.help_outline, 'Help & Support', () {}),
                const SizedBox(height: 24),
                SizedBox(
                  width: double.infinity,
                  child: OutlinedButton(
                    onPressed: () => authService.signOut(),
                    style: OutlinedButton.styleFrom(foregroundColor: AppTheme.errorColor),
                    child: const Text('Sign Out'),
                  ),
                ),
              ],
            ),
          );
        },
      ),
    );
  }

  Widget _buildMenuItem(BuildContext context, IconData icon, String title, VoidCallback onTap) {
    return ListTile(
      leading: Icon(icon),
      title: Text(title),
      trailing: const Icon(Icons.chevron_right),
      onTap: onTap,
    );
  }
}
